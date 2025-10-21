import sqlite3 from 'sqlite3';
import { open } from 'sqlite';

let dbInstance;

export async function getDB() {
  if (!dbInstance) {
    dbInstance = await open({
      filename: './daycare.sqlite',
      driver: sqlite3.Database
    });

    // Create tables if not exist
    await dbInstance.exec(`
      CREATE TABLE IF NOT EXISTS daycares (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT,
        slug TEXT UNIQUE,
        phone TEXT,
        address TEXT,
        hours TEXT,
        meals TEXT,
        fees TEXT,
        programs TEXT,
        tour_link TEXT,
        owner_number TEXT
      );
    `);

    await dbInstance.exec(`
      CREATE TABLE IF NOT EXISTS leads (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        daycare_id INTEGER,
        parent_name TEXT,
        phone TEXT,
        child_age TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);
  }
  return dbInstance;
}
