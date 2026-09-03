// models/Employee.js
import mongoose from 'mongoose';

const employeeSchema = new mongoose.Schema({
  zohoId: { type: String, required: true, unique: true },
  employeeId: { type: String, sparse: true },
  name: { type: String, required: true },
  email: { type: String, default: '-' },
  department: { type: String, default: '-' },
  designation: { type: String, default: '-' }
}, { timestamps: true });

export const Employee = mongoose.model('Employee', employeeSchema);