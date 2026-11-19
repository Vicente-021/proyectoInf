import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';

/** Hash de demostración. En producción se usa Argon2/scrypt con sal. */
export function hashPassword(password) {
  return createHash('sha256').update(String(password)).digest('hex');
}

export function verifyPassword(password, expectedHash) {
  const actual = Buffer.from(hashPassword(password), 'utf8');
  const expected = Buffer.from(String(expectedHash), 'utf8');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** Convierte el header Cookie en un objeto. */
export function parseCookies(header = '') {
  return header
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .reduce((cookies, part) => {
      const index = part.indexOf('=');
      if (index > 0) {
        cookies[part.slice(0, index)] = decodeURIComponent(part.slice(index + 1));
      }
      return cookies;
    }, {});
}

export function createSession(db, userId, hours = 8) {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO sessions (id, user_id, expires_at)
     VALUES (?, ?, datetime('now', ?))`
  ).run(id, userId, `+${hours} hours`);
  return id;
}

export function getSessionUser(db, sessionId) {
  if (!sessionId) return null;
  const user = db
    .prepare(
      `SELECT u.id, u.name, u.role, u.is_admin
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.id = ? AND s.expires_at > datetime('now')`
    )
    .get(sessionId);

  if (!user) {
    db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
    return null;
  }
  return user;
}

export function deleteSession(db, sessionId) {
  if (sessionId) {
    db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
  }
}

export function sessionCookie(sessionId) {
  return `sid=${sessionId}; HttpOnly; SameSite=Lax; Path=/; Max-Age=28800`;
}

export function clearSessionCookie() {
  return 'sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0';
}
