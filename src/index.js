import express from 'express';
import axios from 'axios';
import pLimit from 'p-limit';
import dotenv from 'dotenv';
import cron from 'node-cron';
import mongoose from 'mongoose';

dotenv.config();

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const ZOHO_PEOPLE_URL = process.env.ZOHO_PEOPLE_URL || 'https://people.zoho.com/people/api';
const ZOHO_ACCOUNTS_URL = process.env.ZOHO_ACCOUNTS_URL || 'https://accounts.zoho.com';

// Define Schemas & Models
const employeeSchema = new mongoose.Schema({
  zohoId: { type: String, required: true, unique: true },
  employeeId: { type: String },
  name: { type: String, required: true },
  email: { type: String, default: '-' },
  department: { type: String, default: '-' },
  designation: { type: String, default: '-' }
}, { timestamps: true });

const attendanceLogSchema = new mongoose.Schema({
  employeeId: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', required: true },
  date: { type: String, required: true },
  entries: { type: Array, default: [] }
}, { timestamps: true });

attendanceLogSchema.index({ employeeId: 1, date: 1 }, { unique: true });

const Employee = mongoose.model('Employee', employeeSchema);
const AttendanceLog = mongoose.model('AttendanceLog', attendanceLogSchema);

// Connect to MongoDB and trigger initial sync on startup
mongoose.connect(process.env.DATABASE_URL)
  .then(async () => {
    console.log('📦 MongoDB connected successfully');

    // Startup sync: Fetch yesterday's attendance immediately when app starts
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    
    const day = String(yesterday.getDate()).padStart(2, '0');
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const month = months[yesterday.getMonth()];
    const year = yesterday.getFullYear();
    
    const formattedDate = `${day}-${month}-${year}`;

    try {
      await syncDailyAttendance(formattedDate);
    } catch (error) {
      console.error('❌ Startup sync xatosi:', error.message);
    }
  })
  .catch((err) => console.error('❌ MongoDB connection error:', err));

// ----------------------------------------------------
// 1. TOKEN MANAGER (Auto Refresh)
// ----------------------------------------------------
let cachedAccessToken = null;
let tokenExpiresAt = 0;

async function getAccessToken() {
  const now = Date.now();
  if (cachedAccessToken && now < tokenExpiresAt - 60000) {
    return cachedAccessToken;
  }

  try {
    const res = await axios.post(`${ZOHO_ACCOUNTS_URL}/oauth/v2/token`, null, {
      params: {
        refresh_token: process.env.ZOHO_REFRESH_TOKEN,
        client_id: process.env.ZOHO_CLIENT_ID,
        client_secret: process.env.ZOHO_CLIENT_SECRET,
        grant_type: 'refresh_token',
      },
    });

    if (res.data.error) {
      throw new Error(`Zoho Auth Error: ${res.data.error}`);
    }

    cachedAccessToken = res.data.access_token;
    tokenExpiresAt = now + (res.data.expires_in || 3600) * 1000;
    return cachedAccessToken;
  } catch (error) {
    console.error('❌ Access token olishda xato:', error.response?.data || error.message);
    throw error;
  }
}

// ----------------------------------------------------
// 2. SYNC LOGIC (Fetch & Save to Database)
// ----------------------------------------------------
async function syncDailyAttendance(targetDate) {
  console.log(`\n🔄 [Sync Started] ${targetDate} uchun ma'lumotlar sinxronizatsiya qilinmoqda...`);
  const token = await getAccessToken();

  let allEmployees = [];
  let sIndex = 1;
  const limit = 200;
  let hasMore = true;

  while (hasMore) {
    const response = await axios.get(`${ZOHO_PEOPLE_URL}/forms/employee/getRecords`, {
      headers: { Authorization: `Zoho-oauthtoken ${token}` },
      params: { sformName: 'Employee', sIndex, limit },
    });

    const responseData = response.data?.response;
    if (!responseData || responseData?.status === 1 || !responseData?.result) break;

    const records = responseData.result;
    records.forEach((recordObj) => {
      for (const zohoId in recordObj) {
        const emp = recordObj[zohoId][0];
        if (emp.Employeestatus === 'Active') {
          allEmployees.push({
            zohoId,
            employeeId: emp.EmployeeID ? String(emp.EmployeeID).trim() : null,
            name: emp.Full_Name || `${emp.FirstName || ''} ${emp.LastName || ''}`.trim(),
            email: emp.EmailID || '-',
            department: emp.Department || '-',
            designation: emp.Designation || '-'
          });
        }
      }
    });

    if (records.length < limit) hasMore = false;
    else sIndex += limit;
  }

  const pLimitInstance = pLimit(5);

  for (const emp of allEmployees) {
    await pLimitInstance(async () => {
      try {
        const dbEmployee = await Employee.findOneAndUpdate(
          { zohoId: emp.zohoId },
          {
            name: emp.name,
            email: emp.email,
            department: emp.department,
            designation: emp.designation,
            employeeId: emp.employeeId
          },
          { upsert: true, returnDocument: 'after' }
        );

        const entriesRes = await axios.get(`${ZOHO_PEOPLE_URL}/attendance/getAttendanceEntries`, {
          headers: { Authorization: `Zoho-oauthtoken ${token}` },
          params: { date: targetDate, empId: emp.employeeId || emp.zohoId },
        });

        const rawEntries = entriesRes.data?.entries || [];
        
        await AttendanceLog.findOneAndUpdate(
          { employeeId: dbEmployee._id, date: targetDate },
          { entries: rawEntries },
          { upsert: true, returnDocument: 'after' }
        );
      } catch (err) {
        console.error(`⚠️ Xatolik (${emp.name}):`, err.message);
      }
    });
  }

  console.log(`✅ [Sync Finished] ${targetDate} uchun ma'lumotlar bazaga muvaffaqiyatli saqlandi!`);
}

// ----------------------------------------------------
// 3. CRON JOB (Har kuni soat 02:00 da kechagi kunni fetch qiladi)
// ----------------------------------------------------
cron.schedule('0 2 * * *', async () => {
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  
  const day = String(yesterday.getDate()).padStart(2, '0');
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const month = months[yesterday.getMonth()];
  const year = yesterday.getFullYear();
  
  const formattedDate = `${day}-${month}-${year}`;
  
  try {
    await syncDailyAttendance(formattedDate);
  } catch (error) {
    console.error('❌ Cron job xatosi:', error.message);
  }
});

// ----------------------------------------------------
// 4. AUTHENTICATION MIDDLEWARE FOR PRIVATE ENDPOINTS
// ----------------------------------------------------
function verifyApiKey(req, res, next) {
  const authHeader = req.headers['authorization'];
  
  if (!authHeader) {
    return res.status(401).json({ status: 'error', message: 'Unauthorized: No token provided' });
  }

  const token = authHeader.split(' ')[1] || authHeader;

  if (token !== process.env.API_SECRET_KEY) {
    return res.status(403).json({ status: 'error', message: 'Forbidden: Invalid API key' });
  }

  next();
}

// ----------------------------------------------------
// 5. PRIVATE API ENDPOINTS
// ----------------------------------------------------

// Single date sync (POST)
app.post('/api/attendance/sync', verifyApiKey, async (req, res) => {
  const { date } = req.body;
  if (!date) {
    return res.status(400).json({ status: 'error', message: 'Body da "date" ko\'rsatilishi shart (masalan: 01-Sep-2026)' });
  }

  try {
    await syncDailyAttendance(date);
    return res.json({ status: 'success', message: `${date} uchun ma'lumotlar muvaffaqiyatli sinxronizatsiya qilindi.` });
  } catch (error) {
    return res.status(500).json({ status: 'error', message: error.message });
  }
});

// Full August Sync (POST)
app.post('/api/attendance/sync-august', verifyApiKey, async (req, res) => {
  try {
    const year = 2026;
    const daysInAugust = 31;

    console.log(`\n🚀 [August Sync Started] 2026-yil Avgust oyi uchun to'liq sinxronizatsiya boshlandi...`);

    for (let day = 1; day <= daysInAugust; day++) {
      const formattedDay = String(day).padStart(2, '0');
      const targetDate = `${formattedDay}-Aug-${year}`;
      
      try {
        await syncDailyAttendance(targetDate);
      } catch (dayErr) {
        console.error(`⚠️ ${targetDate} uchun xatolik:`, dayErr.message);
      }
    }

    console.log(`✨ [August Sync Finished] Avgust oyi to'liq bazaga yuklandi!`);
    return res.json({ 
      status: 'success', 
      message: 'Avgust oyi uchun barcha davomat maʼlumotlari muvaffaqiyatli sinxronizatsiya qilindi.' 
    });
  } catch (error) {
    console.error('❌ August sync xatosi:', error.message);
    return res.status(500).json({ status: 'error', message: error.message });
  }
});

// Range Sync (POST) - masalan: 3-dan 7-gacha
app.post('/api/attendance/sync-range', verifyApiKey, async (req, res) => {
  const { startDay = 3, endDay = 7 } = req.body;

  try {
    const year = 2026;
    const month = 'Aug';

    console.log(`\n🚀 [Range Sync Started] ${startDay}-${month}-${year} dan ${endDay}-${month}-${year} gacha sinxronizatsiya boshlandi...`);

    for (let day = startDay; day <= endDay; day++) {
      const formattedDay = String(day).padStart(2, '0');
      const targetDate = `${formattedDay}-${month}-${year}`;
      
      try {
        await syncDailyAttendance(targetDate);
      } catch (dayErr) {
        console.error(`⚠️ ${targetDate} uchun xatolik:`, dayErr.message);
      }
    }

    console.log(`✨ [Range Sync Finished] Belgilangan kunlar oralig'i bazaga yuklandi!`);
    return res.json({ 
      status: 'success', 
      message: `${startDay}-Aug dan ${endDay}-Aug gacha bo'lgan davomat ma'lumotlari muvaffaqiyatli sinxronizatsiya qilindi.` 
    });
  } catch (error) {
    console.error('❌ Range sync xatosi:', error.message);
    return res.status(500).json({ status: 'error', message: error.message });
  }
});

// Get attendance report (GET)
app.get('/api/attendance/report', verifyApiKey, async (req, res) => {
  const { date, page = 1 } = req.query;

  if (!date) {
    return res.status(400).json({ 
      status: 'error', 
      message: 'Date parametri talab qilinadi (masalan: ?date=01-Sep-2026&page=1)' 
    });
  }

  const pageSize = 30;
  const pageNumber = parseInt(page, 10) > 0 ? parseInt(page, 10) : 1;
  const skip = (pageNumber - 1) * pageSize;

  try {
    const [logs, totalCount] = await Promise.all([
      AttendanceLog.find({ date: date })
        .populate('employeeId')
        .skip(skip)
        .limit(pageSize),
      AttendanceLog.countDocuments({ date: date })
    ]);

    return res.json({
      status: 'success',
      date: date,
      pagination: {
        total_records: totalCount,
        per_page: pageSize,
        current_page: pageNumber,
        total_pages: Math.ceil(totalCount / pageSize)
      },
      data: logs.map(log => ({
        employee: log.employeeId,
        date: log.date,
        entriesCount: log.entries ? log.entries.length : 0,
        entries: log.entries
      }))
    });
  } catch (error) {
    console.error('❌ Endpoint xatosi:', error.message);
    return res.status(500).json({ status: 'error', message: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`🎯 Server http://localhost:${PORT} manzilida ishlamoqda`);
});