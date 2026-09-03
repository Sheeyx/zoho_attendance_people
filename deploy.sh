#!/bin/bash

# Xatolik chiqsa, skriptni darhol to'xtatish
set -e

echo "🚀 Deploy boshlandi..."

# 1. Git'dan eng so'nggi o'zgarishlarni tortib olish (asosiy tarmoq - main)
echo "📥 Git pull qilinmoqda..."
git pull origin main

# 2. Yangi kutubxonalar bo'lsa o'rnatish
echo "📦 NPM packages o'rnatilmoqda..."
npm install

# 3. PM2 orqali ishlayotgan serverni yangilash / qayta ishga tushirish
echo "🔄 Server PM2 orqali qayta ishga tushirilmoqda..."
pm2 restart zoho-sync-server || pm2 start src/index.js --name "zoho-sync-server"

echo "✨ Deploy muvaffaqiyatli yakunlandi!"