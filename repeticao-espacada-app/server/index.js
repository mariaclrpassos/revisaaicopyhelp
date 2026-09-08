const path = require("path");
const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");

const PORT = process.env.PORT || 8080;
const DATABASE_URL = process.env.DATABASE_URL;

const pool = new Pool({ connectionString: DATABASE_URL });

async function initDb(retries = 20) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS tree_state (
          id text PRIMARY KEY,
          data jsonb NOT NULL,
          updated_at timestamptz NOT NULL DEFAULT now()
        );
      `);
      console.log("Postgres ready, tree_state table ensured.");
      return;
    } catch (err) {
      console.log(`Postgres not ready yet (attempt ${attempt}/${retries}): ${err.message}`);
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  throw new Error("Could not connect to Postgres after retries.");
}

const app = express();
app.use(cors());
app.use(express.json({ limit: "5mb" }));

app.get("/health", (req, res) => res.json({ ok: true }));

const WORKSPACE_CODE_RE = /^[a-zA-Z0-9_-]{1,64}$/;

app.get("/api/tree/:code", async (req, res) => {
  if (!WORKSPACE_CODE_RE.test(req.params.code)) {
    return res.status(400).json({ error: "invalid workspace code" });
  }
  try {
    const { rows } = await pool.query("SELECT data FROM tree_state WHERE id = $1", [req.params.code]);
    res.json(rows[0] ? rows[0].data : { nodes: {} });
  } catch (err) {
    console.error("GET /api/tree/:code failed:", err);
    res.status(500).json({ error: "failed to load tree" });
  }
});

app.put("/api/tree/:code", async (req, res) => {
  if (!WORKSPACE_CODE_RE.test(req.params.code)) {
    return res.status(400).json({ error: "invalid workspace code" });
  }
  const body = req.body;
  if (!body || typeof body !== "object" || typeof body.nodes !== "object") {
    return res.status(400).json({ error: "expected { nodes: {...} }" });
  }
  try {
    await pool.query(
      `INSERT INTO tree_state (id, data, updated_at)
       VALUES ($1, $2, now())
       ON CONFLICT (id) DO UPDATE SET data = $2, updated_at = now()`,
      [req.params.code, body]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error("PUT /api/tree/:code failed:", err);
    res.status(500).json({ error: "failed to save tree" });
  }
});

// serve o frontend estático (copiado pra ./public no build da imagem)
app.use(express.static(path.join(__dirname, "public")));
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

initDb()
  .then(() => {
    app.listen(PORT, () => console.log(`Revisa API + frontend rodando na porta ${PORT}`));
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
