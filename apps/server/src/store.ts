import { DatabaseSync } from "node:sqlite";
import type { RecordedEvent, Recording, RunSnapshot, Workflow } from "@d2a/shared";

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
      CREATE TABLE IF NOT EXISTS step_overrides (
        recording_id TEXT NOT NULL REFERENCES recordings(id),
        event_index INTEGER NOT NULL,
        noise INTEGER NOT NULL,
        PRIMARY KEY (recording_id, event_index)
      );
      CREATE TABLE IF NOT EXISTS workflows (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, data TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL, data TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS screenshots (
        id TEXT PRIMARY KEY,
        recording_id TEXT NOT NULL REFERENCES recordings(id),
        mime TEXT NOT NULL,
        data BLOB NOT NULL
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

  /** Stores a `data:` URL screenshot as a blob. */
  saveScreenshot(id: string, recordingId: string, dataUrl: string) {
    const match = /^data:([^;]+);base64,(.*)$/s.exec(dataUrl);
    if (!match) throw new Error("screenshot is not a base64 data URL");
    this.db
      .prepare("INSERT OR REPLACE INTO screenshots (id, recording_id, mime, data) VALUES (?, ?, ?, ?)")
      .run(id, recordingId, match[1], Buffer.from(match[2], "base64"));
  }

  getScreenshot(id: string) {
    return this.db.prepare("SELECT mime, data FROM screenshots WHERE id = ?").get(id) as
      | { mime: string; data: Uint8Array }
      | undefined;
  }

  listRecordings() {
    return this.db
      .prepare(
        `SELECT r.id, r.name, r.created_at AS createdAt,
                (SELECT COUNT(*) FROM recorded_events e WHERE e.recording_id = r.id) AS eventCount
         FROM recordings r ORDER BY r.created_at DESC`,
      )
      .all() as { id: string; name: string; createdAt: number; eventCount: number }[];
  }

  saveWorkflow(wf: Workflow) {
    this.db
      .prepare(
        `INSERT INTO workflows (id, name, data, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, data = excluded.data`,
      )
      .run(wf.id, wf.name, JSON.stringify(wf), Date.now());
  }

  getWorkflow(id: string): Workflow | undefined {
    const row = this.db.prepare("SELECT data FROM workflows WHERE id = ?").get(id) as { data: string } | undefined;
    return row && JSON.parse(row.data);
  }

  listWorkflows() {
    return this.db
      .prepare("SELECT id, name, created_at AS createdAt FROM workflows ORDER BY created_at DESC")
      .all() as { id: string; name: string; createdAt: number }[];
  }

  deleteWorkflow(id: string) {
    return this.db.prepare("DELETE FROM workflows WHERE id = ?").run(id).changes > 0;
  }

  saveRun(run: RunSnapshot) {
    this.db
      .prepare(
        `INSERT INTO runs (id, workflow_id, data, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET data = excluded.data`,
      )
      .run(run.id, run.workflowId, JSON.stringify(run), run.startedAt);
  }

  getRun(id: string): RunSnapshot | undefined {
    const row = this.db.prepare("SELECT data FROM runs WHERE id = ?").get(id) as { data: string } | undefined;
    return row && JSON.parse(row.data);
  }

  deleteRecording(id: string) {
    this.db.prepare("DELETE FROM screenshots WHERE recording_id = ?").run(id);
    this.db.prepare("DELETE FROM step_overrides WHERE recording_id = ?").run(id);
    this.db.prepare("DELETE FROM recorded_events WHERE recording_id = ?").run(id);
    return this.db.prepare("DELETE FROM recordings WHERE id = ?").run(id).changes > 0;
  }

  getRecording(id: string): Recording | undefined {
    const row = this.db
      .prepare("SELECT id, name, created_at AS createdAt FROM recordings WHERE id = ?")
      .get(id) as { id: string; name: string; createdAt: number } | undefined;
    if (!row) return undefined;
    const events = this.db
      .prepare("SELECT data FROM recorded_events WHERE recording_id = ? ORDER BY seq")
      .all(id) as { data: string }[];
    const overrides = this.db
      .prepare("SELECT event_index AS i, noise FROM step_overrides WHERE recording_id = ?")
      .all(id) as { i: number; noise: number }[];
    return {
      ...row,
      events: events.map((e) => JSON.parse(e.data)),
      overrides: Object.fromEntries(overrides.map((o) => [String(o.i), Boolean(o.noise)])),
    };
  }

  /** Records the user's keep/noise decision for the step starting at eventIndex; null clears it. */
  setOverride(recordingId: string, eventIndex: number, noise: boolean | null) {
    if (noise === null) {
      this.db.prepare("DELETE FROM step_overrides WHERE recording_id = ? AND event_index = ?").run(recordingId, eventIndex);
    } else {
      this.db
        .prepare("INSERT OR REPLACE INTO step_overrides (recording_id, event_index, noise) VALUES (?, ?, ?)")
        .run(recordingId, eventIndex, noise ? 1 : 0);
    }
  }
}
