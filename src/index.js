import express from 'express';
import axios from 'axios';
import pLimit from 'p-limit';
import dotenv from 'dotenv';
import cron from 'node-cron';
import mongoose from 'mongoose';
import cors from 'cors';

dotenv.config();

const app = express();

app.use(cors());
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
// 2. SYNC LOGIC
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
// 3. CRON JOB (Har kuni soat 18:00 UZB vaqti / UTC 13:00 da ishlaydi)
// ----------------------------------------------------
cron.schedule('0 13 * * *', async () => {
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
// 4. AUTHENTICATION MIDDLEWARE
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
// 5. SYNC API ENDPOINTS
// ----------------------------------------------------
app.post('/api/attendance/sync', verifyApiKey, async (req, res) => {
  const { date } = req.body;
  if (!date) {
    return res.status(400).json({ status: 'error', message: 'Body da "date" ko\'rsatilishi shart' });
  }

  try {
    await syncDailyAttendance(date);
    return res.json({ status: 'success', message: `${date} uchun sinxronizatsiya qilindi.` });
  } catch (error) {
    return res.status(500).json({ status: 'error', message: error.message });
  }
});

app.post('/api/attendance/sync-august', verifyApiKey, async (req, res) => {
  try {
    for (let day = 1; day <= 31; day++) {
      const targetDate = `${String(day).padStart(2, '0')}-Aug-2026`;
      await syncDailyAttendance(targetDate);
    }
    return res.json({ status: 'success', message: 'Avgust oyi to\'liq sinxronizatsiya qilindi.' });
  } catch (error) {
    return res.status(500).json({ status: 'error', message: error.message });
  }
});

app.post('/api/attendance/sync-range', verifyApiKey, async (req, res) => {
  const { startDay = 3, endDay = 7 } = req.body;
  try {
    for (let day = startDay; day <= endDay; day++) {
      const targetDate = `${String(day).padStart(2, '0')}-Aug-2026`;
      await syncDailyAttendance(targetDate);
    }
    return res.json({ status: 'success', message: 'Oraliq sinxronizatsiya qilindi.' });
  } catch (error) {
    return res.status(500).json({ status: 'error', message: error.message });
  }
});

// ----------------------------------------------------
// 6. REPORT & EMPLOYEE ENDPOINTS
// ----------------------------------------------------
function buildEmployeeQuery(department, search) {
  const query = {};
  if (department && department !== 'all') {
    query.department = { $regex: new RegExp(`^${department}$`, 'i') };
  }
  if (search) {
    query.$or = [
      { name: { $regex: new RegExp(search, 'i') } },
      { email: { $regex: new RegExp(search, 'i') } },
      { employeeId: { $regex: new RegExp(search, 'i') } }
    ];
  }
  return query;
}

app.get('/api/attendance/daily', verifyApiKey, async (req, res) => {
  const { date, department, search, page = 1 } = req.query;

  if (!date) {
    return res.status(400).json({ status: 'error', message: 'Date parametri talab qilinadi' });
  }

  const pageSize = 30;
  const pageNumber = Math.max(1, parseInt(page, 10));
  const skip = (pageNumber - 1) * pageSize;

  try {
    const empQuery = buildEmployeeQuery(department, search);
    const totalEmployees = await Employee.countDocuments(empQuery);
    const employees = await Employee.find(empQuery)
      .sort({ name: 1 })
      .skip(skip)
      .limit(pageSize);

    const employeeIds = employees.map(e => e._id);
    const logs = await AttendanceLog.find({
      employeeId: { $in: employeeIds },
      date: date
    });

    const logMap = {};
    logs.forEach(log => {
      logMap[log.employeeId.toString()] = log;
    });

    const data = employees.map(emp => {
      const log = logMap[emp._id.toString()];
      return {
        employee: emp,
        date: date,
        entriesCount: log ? log.entries.length : 0,
        entries: log ? log.entries : []
      };
    });

    return res.json({
      status: 'success',
      date,
      pagination: {
        total_records: totalEmployees,
        per_page: pageSize,
        current_page: pageNumber,
        total_pages: Math.ceil(totalEmployees / pageSize)
      },
      data
    });
  } catch (error) {
    console.error('❌ Daily report error:', error.message);
    return res.status(500).json({ status: 'error', message: error.message });
  }
});

app.get('/api/attendance/weekly', verifyApiKey, async (req, res) => {
  const { month = 'Aug', year = '2026', startDay = 1, endDay = 7, department, search, page = 1 } = req.query;

  const pageSize = 30;
  const pageNumber = Math.max(1, parseInt(page, 10));
  const skip = (pageNumber - 1) * pageSize;

  try {
    const empQuery = buildEmployeeQuery(department, search);
    const totalEmployees = await Employee.countDocuments(empQuery);
    const employees = await Employee.find(empQuery)
      .sort({ name: 1 })
      .skip(skip)
      .limit(pageSize);

    const employeeIds = employees.map(e => e._id);
    const targetDates = [];
    for (let day = parseInt(startDay, 10); day <= parseInt(endDay, 10); day++) {
      targetDates.push(`${String(day).padStart(2, '0')}-${month}-${year}`);
    }

    const logs = await AttendanceLog.find({
      employeeId: { $in: employeeIds },
      date: { $in: targetDates }
    });

    const employeeLogsMap = {};
    logs.forEach(log => {
      const empIdStr = log.employeeId.toString();
      if (!employeeLogsMap[empIdStr]) {
        employeeLogsMap[empIdStr] = [];
      }
      employeeLogsMap[empIdStr].push({
        date: log.date,
        entriesCount: log.entries.length,
        entries: log.entries
      });
    });

    const data = employees.map(emp => ({
      employee: emp,
      attendance: employeeLogsMap[emp._id.toString()] || []
    }));

    return res.json({
      status: 'success',
      filter: { startDay, endDay, month, year, department: department || 'all', search: search || '' },
      pagination: {
        total_records: totalEmployees,
        per_page: pageSize,
        current_page: pageNumber,
        total_pages: Math.ceil(totalEmployees / pageSize)
      },
      data
    });
  } catch (error) {
    console.error('❌ Weekly report error:', error.message);
    return res.status(500).json({ status: 'error', message: error.message });
  }
});

app.get('/api/attendance/monthly', verifyApiKey, async (req, res) => {
  const { month = 'Aug', year = '2026', department, search, page = 1 } = req.query;

  const pageSize = 30;
  const pageNumber = Math.max(1, parseInt(page, 10));
  const skip = (pageNumber - 1) * pageSize;

  try {
    const empQuery = buildEmployeeQuery(department, search);
    const totalEmployees = await Employee.countDocuments(empQuery);
    const employees = await Employee.find(empQuery)
      .sort({ name: 1 })
      .skip(skip)
      .limit(pageSize);

    const employeeIds = employees.map(e => e._id);
    const dateRegex = new RegExp(`-${month}-${year}$`, 'i');

    const logs = await AttendanceLog.find({
      employeeId: { $in: employeeIds },
      date: dateRegex
    });

    const employeeLogsMap = {};
    logs.forEach(log => {
      const empIdStr = log.employeeId.toString();
      if (!employeeLogsMap[empIdStr]) {
        employeeLogsMap[empIdStr] = [];
      }
      employeeLogsMap[empIdStr].push({
        date: log.date,
        entriesCount: log.entries.length,
        entries: log.entries
      });
    });

    const data = employees.map(emp => ({
      employee: emp,
      attendance: employeeLogsMap[emp._id.toString()] || []
    }));

    return res.json({
      status: 'success',
      filter: { month, year, department: department || 'all', search: search || '' },
      pagination: {
        total_records: totalEmployees,
        per_page: pageSize,
        current_page: pageNumber,
        total_pages: Math.ceil(totalEmployees / pageSize)
      },
      data
    });
  } catch (error) {
    console.error('❌ Monthly report error:', error.message);
    return res.status(500).json({ status: 'error', message: error.message });
  }
});

// Single employee lookup endpoints
app.get('/api/employee/:id', verifyApiKey, async (req, res) => {
  const { id } = req.params;
  try {
    const employee = await Employee.findOne({
      $or: [
        { _id: mongoose.Types.ObjectId.isValid(id) ? id : null },
        { employeeId: id },
        { zohoId: id }
      ]
    });

    if (!employee) {
      return res.status(404).json({ status: 'error', message: 'Employee not found' });
    }

    return res.json({ status: 'success', data: employee });
  } catch (error) {
    console.error('❌ Get single employee error:', error.message);
    return res.status(500).json({ status: 'error', message: error.message });
  }
});

app.get('/api/employee/search/:name', verifyApiKey, async (req, res) => {
  const { name } = req.params;
  try {
    const employees = await Employee.find({
      name: { $regex: new RegExp(name, 'i') }
    });

    if (!employees || employees.length === 0) {
      return res.status(404).json({ status: 'error', message: 'No employees found with this name' });
    }

    return res.json({ status: 'success', count: employees.length, data: employees });
  } catch (error) {
    console.error('❌ Search employee by name error:', error.message);
    return res.status(500).json({ status: 'error', message: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`🎯 Server http://localhost:${PORT} manzilida ishlamoqda`);
});