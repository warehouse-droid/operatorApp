export function normalizeAccountEmail(value) {
  const email = String(value ?? '').trim().toLowerCase();
  if (email && (email.length > 254 || !/^[^\s@<>(),;:\\"]+@[^\s@<>(),;:\\"]+\.[^\s@<>(),;:\\"]+$/.test(email))) {
    throw Object.assign(new Error('Enter a valid email address.'), { status: 400, code: 'INVALID_ACCOUNT_EMAIL' });
  }
  return email;
}
