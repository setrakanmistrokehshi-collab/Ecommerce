const { SignJWT, jwtVerify } = require('jose');

// Your JWT_SECRET from .env — jose needs it as a Uint8Array
const SECRET = new TextEncoder().encode(process.env.JWT_SECRET);
const ALGORITHM = 'HS256'; // or 'RS256' if you use RSA keys

async function signToken(payload, expiresIn = '15m') {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: ALGORITHM })
    .setIssuedAt()
    .setExpirationTime(expiresIn)
    .sign(SECRET);
}

async function verifyToken(token) {
  const { payload } = await jwtVerify(token, SECRET, {
    algorithms: [ALGORITHM], // explicitly lock algorithm — prevents confusion attacks
  });
  return payload;
}

module.exports = { signToken, verifyToken };