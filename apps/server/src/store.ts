import { DatabaseSync } from "node:sqlite";
import type { RecordedEvent, Recording } from "@d2a/shared";

export class Store {
  private db: DatabaseSync;

  constructor(path = process.env.D2A_DB ?? "d2a.db") {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS recordings (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS recorded_events (
        recording_id TEXT NOT NULL REFERENCES recordings(id),
        seq INTEGER NOT NULL,
        data TEXT NOT NULL,
        PRIMARY KEY (recording_id, seq)
      );
    `);
  }

  createRecording(id: string, name: string) {
    this.db
      .prepare("INSERT OR IGNORE INTO recordings (id, name, created_at) VALUES (?, ?, ?)")
      .run(id, name, Date.now());
  }

  appendEvent(recordingId: string, event: RecordedEvent) {
    this.db
      .prepare(
        `INSERT INTO recorded_events (recording_id, seq, data)
         VALUES (?, (SELECT COALESCE(MAX(seq), -1) + 1 FROM recorded_events WHERE recording_id = ?), ?)`,
      )
      .run(recordingId, recordingId, JSON.stringify(event));
  }

  listRecordings() {
    return this.db
      .prepare("SELECT id, name, created_at AS createdAt FROM recordings ORDER BY created_at DESC")
      .all() as { id: string; name: string; createdAt: number }[];
  }

  getRecording(id: string): Recording | undefined {
    const row = this.db
      .prepare("SELECT id, name, created_at AS createdAt FROM recordings WHERE id = ?")
      .get(id) as { id: string; name: string; createdAt: number } | undefined;
    if (!row) return undefined;
    const events = this.db
      .prepare("SELECT data FROM recorded_events WHERE recording_id = ? ORDER BY seq")
      .all(id) as { data: string }[];
    return { ...row, events: events.map((e) => JSON.parse(e.data)) };
  }
}
