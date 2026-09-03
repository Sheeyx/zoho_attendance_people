// models/AttendanceLog.js
import mongoose from 'mongoose';

const attendanceLogSchema = new mongoose.Schema({
  employeeId: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', required: true },
  date: { type: String, required: true },
  entries: { type: Array, default: [] }
}, { timestamps: true });

attendanceLogSchema.index({ employeeId: 1, date: 1 }, { unique: true });

export const AttendanceLog = mongoose.model('AttendanceLog', attendanceLogSchema);