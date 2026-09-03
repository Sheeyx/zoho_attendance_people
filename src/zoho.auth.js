import axios from 'axios';
import dotenv from 'dotenv';
dotenv.config();

let cachedAccessToken = null;
let tokenExpiresAt = 0;

export async function getAccessToken() {
  const now = Date.now();

  // Agar token bor bo'lsa va muddati tugashiga 60 soniyadan ko'proq vaqt bo'lsa, eskisini ishlatamiz
  if (cachedAccessToken && now < tokenExpiresAt - 60000) {
    return cachedAccessToken;
  }

  try {
    const res = await axios.post(`${process.env.ZOHO_ACCOUNTS_URL}/oauth/v2/token`, null, {
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
    // expires_in odatda 3600 soniya (1 soat) bo'ladi
    tokenExpiresAt = now + (res.data.expires_in || 3600) * 1000;

    return cachedAccessToken;
  } catch (error) {
    console.error('Access token olishda xatolik:', error.response?.data || error.message);
    throw error;
  }
}