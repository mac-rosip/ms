const Database = require('better-sqlite3');
const path = require('path');

class TokenStorage {
  constructor() {
    this.dbPath = path.join(__dirname, 'tokens.db');
    this.db = null;
  }

  init() {
    try {
      // Initialize database
      this.db = new Database(this.dbPath);
      
      // Enable WAL mode for better concurrency
      this.db.pragma('journal_mode = WAL');
      
      // Create tokens table
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS tokens (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id TEXT UNIQUE NOT NULL,
          user_email TEXT,
          access_token TEXT NOT NULL,
          refresh_token TEXT NOT NULL,
          token_type TEXT,
          expires_at INTEGER NOT NULL,
          scope TEXT,
          metadata TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        )
      `);
      
      // Create index for faster lookups
      this.db.exec(`
        CREATE INDEX IF NOT EXISTS idx_user_id ON tokens(user_id);
        CREATE INDEX IF NOT EXISTS idx_expires_at ON tokens(expires_at);
      `);
      
      // Create short links table
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS short_links (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          short_code TEXT UNIQUE NOT NULL,
          target_url TEXT NOT NULL,
          user_id TEXT,
          clicks INTEGER DEFAULT 0,
          created_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL
        )
      `);
      
      this.db.exec(`
        CREATE INDEX IF NOT EXISTS idx_short_code ON short_links(short_code);
        CREATE INDEX IF NOT EXISTS idx_short_expires ON short_links(expires_at);
      `);
      
      const count = this.db.prepare('SELECT COUNT(*) as count FROM tokens').get();
      console.log('✓ Token database initialized');
      console.log(`✓ Found ${count.count} stored token(s)`);
      
      // Show expiring tokens
      const now = Date.now();
      const expiringSoon = this.db.prepare(`
        SELECT user_id, expires_at FROM tokens 
        WHERE expires_at > ? AND expires_at < ?
      `).all(now, now + 10 * 60 * 1000);
      
      if (expiringSoon.length > 0) {
        expiringSoon.forEach(token => {
          const expiresIn = Math.round((token.expires_at - now) / 1000);
          console.log(`  ⚠️  Token for ${token.user_id} expires in ${expiresIn}s`);
        });
      }
    } catch (error) {
      console.error('Error initializing database:', error.message);
      throw error;
    }
  }

  saveToken(tokenData) {
    try {
      const now = Date.now();
      const userId = tokenData.userId || 'default';
      
      const stmt = this.db.prepare(`
        INSERT INTO tokens (
          user_id, user_email, access_token, refresh_token, 
          token_type, expires_at, scope, metadata, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(user_id) DO UPDATE SET
          access_token = excluded.access_token,
          refresh_token = excluded.refresh_token,
          token_type = excluded.token_type,
          expires_at = excluded.expires_at,
          scope = excluded.scope,
          metadata = excluded.metadata,
          updated_at = excluded.updated_at
      `);
      
      stmt.run(
        userId,
        tokenData.userEmail || null,
        tokenData.access_token,
        tokenData.refresh_token,
        tokenData.token_type || 'Bearer',
        tokenData.expires_at,
        tokenData.scope || '',
        JSON.stringify(tokenData.metadata || {}),
        now,
        now
      );
      
      console.log(`Token saved to database for user: ${userId}`);
    } catch (error) {
      console.error('Error saving token:', error.message);
      throw error;
    }
  }

  getToken(userId = 'default') {
    try {
      const stmt = this.db.prepare(`
        SELECT * FROM tokens WHERE user_id = ?
      `);
      
      const row = stmt.get(userId);
      if (!row) {
        return null;
      }
      
      // Convert database row to token object
      return {
        userId: row.user_id,
        userEmail: row.user_email,
        access_token: row.access_token,
        refresh_token: row.refresh_token,
        token_type: row.token_type,
        expires_at: row.expires_at,
        scope: row.scope,
        metadata: JSON.parse(row.metadata || '{}'),
        created_at: row.created_at,
        updated_at: row.updated_at
      };
    } catch (error) {
      console.error('Error reading token:', error.message);
      return null;
    }
  }

  getAllTokens() {
    try {
      const stmt = this.db.prepare('SELECT * FROM tokens');
      const rows = stmt.all();
      
      return rows.map(row => ({
        userId: row.user_id,
        userEmail: row.user_email,
        access_token: row.access_token,
        refresh_token: row.refresh_token,
        token_type: row.token_type,
        expires_at: row.expires_at,
        scope: row.scope,
        metadata: JSON.parse(row.metadata || '{}'),
        created_at: row.created_at,
        updated_at: row.updated_at
      }));
    } catch (error) {
      console.error('Error reading all tokens:', error.message);
      return [];
    }
  }

  deleteToken(userId = 'default') {
    try {
      const stmt = this.db.prepare('DELETE FROM tokens WHERE user_id = ?');
      const result = stmt.run(userId);
      
      if (result.changes > 0) {
        console.log(`Token deleted for user: ${userId}`);
      }
      return result.changes > 0;
    } catch (error) {
      console.error('Error deleting token:', error.message);
      return false;
    }
  }

  isTokenValid(userId = 'default') {
    const token = this.getToken(userId);
    if (!token || !token.expires_at) {
      return false;
    }
    
    // Check if token expires in more than 5 minutes
    return token.expires_at - Date.now() > 5 * 60 * 1000;
  }

  getExpiringTokens(minutesThreshold = 10) {
    try {
      const thresholdTime = Date.now() + (minutesThreshold * 60 * 1000);
      const stmt = this.db.prepare(`
        SELECT * FROM tokens 
        WHERE expires_at < ? AND expires_at > ?
        ORDER BY expires_at ASC
      `);
      
      const rows = stmt.all(thresholdTime, Date.now());
      return rows.map(row => ({
        userId: row.user_id,
        userEmail: row.user_email,
        access_token: row.access_token,
        refresh_token: row.refresh_token,
        token_type: row.token_type,
        expires_at: row.expires_at,
        scope: row.scope,
        metadata: JSON.parse(row.metadata || '{}')
      }));
    } catch (error) {
      console.error('Error getting expiring tokens:', error.message);
      return [];
    }
  }

  cleanupExpiredTokens() {
    try {
      const stmt = this.db.prepare('DELETE FROM tokens WHERE expires_at < ?');
      const result = stmt.run(Date.now());
      
      if (result.changes > 0) {
        console.log(`Cleaned up ${result.changes} expired token(s)`);
      }
      return result.changes;
    } catch (error) {
      console.error('Error cleaning up expired tokens:', error.message);
      return 0;
    }
  }

  getStats() {
    try {
      const total = this.db.prepare('SELECT COUNT(*) as count FROM tokens').get().count;
      const valid = this.db.prepare('SELECT COUNT(*) as count FROM tokens WHERE expires_at > ?').get(Date.now()).count;
      const expired = this.db.prepare('SELECT COUNT(*) as count FROM tokens WHERE expires_at <= ?').get(Date.now()).count;
      
      return { total, valid, expired };
    } catch (error) {
      console.error('Error getting stats:', error.message);
      return { total: 0, valid: 0, expired: 0 };
    }
  }

  // Short link methods
  saveShortLink(shortCode, targetUrl, userId = null, expiresInMinutes = 10) {
    try {
      const now = Date.now();
      const expiresAt = now + (expiresInMinutes * 60 * 1000);
      
      const stmt = this.db.prepare(`
        INSERT INTO short_links (short_code, target_url, user_id, created_at, expires_at)
        VALUES (?, ?, ?, ?, ?)
      `);
      
      stmt.run(shortCode, targetUrl, userId, now, expiresAt);
      console.log(`Short link created: ${shortCode}`);
      return true;
    } catch (error) {
      console.error('Error saving short link:', error.message);
      return false;
    }
  }

  getShortLink(shortCode) {
    try {
      const stmt = this.db.prepare(`
        SELECT * FROM short_links WHERE short_code = ? AND expires_at > ?
      `);
      
      const row = stmt.get(shortCode, Date.now());
      if (!row) {
        return null;
      }
      
      // Increment click count
      this.db.prepare('UPDATE short_links SET clicks = clicks + 1 WHERE short_code = ?').run(shortCode);
      
      return {
        shortCode: row.short_code,
        targetUrl: row.target_url,
        userId: row.user_id,
        clicks: row.clicks + 1,
        createdAt: row.created_at,
        expiresAt: row.expires_at
      };
    } catch (error) {
      console.error('Error getting short link:', error.message);
      return null;
    }
  }

  cleanupExpiredShortLinks() {
    try {
      const stmt = this.db.prepare('DELETE FROM short_links WHERE expires_at < ?');
      const result = stmt.run(Date.now());
      
      if (result.changes > 0) {
        console.log(`Cleaned up ${result.changes} expired short link(s)`);
      }
      return result.changes;
    } catch (error) {
      console.error('Error cleaning up expired short links:', error.message);
      return 0;
    }
  }

  getShortLinkStats() {
    try {
      const total = this.db.prepare('SELECT COUNT(*) as count FROM short_links').get().count;
      const active = this.db.prepare('SELECT COUNT(*) as count FROM short_links WHERE expires_at > ?').get(Date.now()).count;
      const totalClicks = this.db.prepare('SELECT SUM(clicks) as total FROM short_links').get().total || 0;
      
      return { total, active, totalClicks };
    } catch (error) {
      console.error('Error getting short link stats:', error.message);
      return { total: 0, active: 0, totalClicks: 0 };
    }
  }

  close() {
    if (this.db) {
      this.db.close();
      console.log('Database connection closed');
    }
  }
}

module.exports = TokenStorage;
