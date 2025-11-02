// backend/server.js
import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import jwt from "jsonwebtoken";
import dotenv from "dotenv";
import { PrismaClient } from "@prisma/client";
import twilio from "twilio";
import multer from "multer";
import fs from "fs";

dotenv.config();

/* ---------- Paths ---------- */
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/* Ensure uploads dir exists */
const UPLOAD_DIR = path.join(__dirname, "uploads");
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

/* ---------- App & DB ---------- */
const app = express();
const prisma = new PrismaClient();

/* ---------- Environment ---------- */
const PORT = Number(process.env.PORT || 8080);
const JWT_SECRET = process.env.JWT_SECRET || "change_me";

/* DEV OTP MODE:
   - If DEV_OTP_MODE=console, OTP is NOT sent via SMS.
   - OTP is printed to console and returned in API response for local testing. */
const DEV_OTP_MODE = (process.env.DEV_OTP_MODE || "").toLowerCase() === "console";

/* Optional Twilio (ignored in DEV mode) */
const TWILIO_SID   = process.env.TWILIO_ACCOUNT_SID || "";
const TWILIO_TOKEN = process.env.TWILIO_AUTH_TOKEN || "";
const TWILIO_FROM  = process.env.TWILIO_FROM || "";
const smsClient = (TWILIO_SID && TWILIO_TOKEN) ? twilio(TWILIO_SID, TWILIO_TOKEN) : null;

/* ---------- Middleware ---------- */
app.use(express.json({ limit: "5mb" }));
app.use(express.static(path.join(__dirname, "public")));
app.use("/uploads", express.static(UPLOAD_DIR)); // serve uploaded files

/* ---------- Multer (image uploads) ---------- */
const allowed = new Set(["image/jpeg", "image/png", "image/webp"]);
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const ext = file.mimetype === "image/png" ? ".png"
              : file.mimetype === "image/webp" ? ".webp"
              : ".jpg";
    const name = Date.now() + "-" + Math.random().toString(36).slice(2, 8) + ext;
    cb(null, name);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB
  fileFilter: (_req, file, cb) => {
    if (allowed.has(file.mimetype)) return cb(null, true);
    cb(new Error("Only JPG/PNG/WebP images allowed"));
  }
});

/* ---------- Utils ---------- */
function toE164(phone) {
  const digits = String(phone).replace(/\D/g, "");
  if (digits.length === 10) return `+91${digits}`;
  if (digits.startsWith("91") && digits.length === 12) return `+${digits}`;
  if (digits.startsWith("0") && digits.length === 11) return `+91${digits.slice(1)}`;
  if (String(phone).startsWith("+")) return phone;
  return `+${digits}`;
}

async function sendSms(to, body) {
  if (DEV_OTP_MODE) {
    console.log(`[DEV OTP] to=${to} :: ${body}`);
    return { ok: true, dev: true };
  }
  if (smsClient && TWILIO_FROM) {
    try {
      await smsClient.messages.create({ to, from: TWILIO_FROM, body });
      return { ok: true, dev: false };
    } catch (e) {
      console.log("Twilio error:", e?.message);
      return { ok: false, dev: false, error: e?.message || "twilio_failed" };
    }
  } else {
    console.log(`[DEV OTP] (no Twilio configured) to=${to} :: ${body}`);
    return { ok: true, dev: true };
  }
}

function auth(req, res, next) {
  const hdr = req.headers.authorization || "";
  const token = hdr.startsWith("Bearer ") ? hdr.slice(7) : null;
  if (!token) return res.status(401).json({ error: "unauthorized" });
  try { req.user = jwt.verify(token, JWT_SECRET); next(); }
  catch { return res.status(401).json({ error: "unauthorized" }); }
}

/* ---------- Health ---------- */
app.get("/health", async (_req, res) => {
  try { await prisma.$queryRaw`SELECT 1`; res.json({ ok: true, db: "up", devOtpMode: DEV_OTP_MODE }); }
  catch { res.json({ ok: true, db: "down", devOtpMode: DEV_OTP_MODE }); }
});

/* ---------- OTP: Start / Verify ---------- */
app.post("/auth/otp/start", async (req, res) => {
  try {
    const rawPhone = req.body?.phone;
    if (!rawPhone) return res.status(400).json({ error: "phone required" });

    const phone = String(rawPhone).trim();
    const now = new Date();

    const existing = await prisma.otp.findUnique({ where: { phone } });
    if (existing) {
      const deltaSec = (now.getTime() - existing.createdAt.getTime()) / 1000;
      if (deltaSec < 45) return res.status(429).json({ error: `Please wait ${Math.ceil(45 - deltaSec)}s` });
    }

    const code = String(Math.floor(100000 + Math.random() * 900000));
    const expiresAt = new Date(now.getTime() + 5 * 60 * 1000);

    await prisma.otp.upsert({
      where: { phone },
      update: { code, expiresAt, createdAt: now, attempts: 0 },
      create: { phone, code, expiresAt, createdAt: now }
    });

    const e164 = toE164(phone);
    const sent = await sendSms(e164, `Your Pakari OTP is ${code}. Valid for 5 minutes.`);
    if (!sent.ok && !sent.dev) return res.status(500).json({ error: "Failed to send OTP", detail: sent.error || null });

    return res.json({ok: true,
  message: "OTP sent successfully"
});

  } catch (e) { res.status(500).json({ error: e?.message || "failed" }); }
});

app.post("/auth/otp/verify", async (req, res) => {
  try {
    const rawPhone = req.body?.phone;
    const rawCode  = req.body?.code;
    if (!rawPhone || !rawCode) return res.status(400).json({ error: "phone and code required" });

    const phone = String(rawPhone).trim();
    const code  = String(rawCode).trim();

    const row = await prisma.otp.findUnique({ where: { phone } });
    if (!row) return res.status(400).json({ error: "start OTP first" });

    const now = new Date();
    if (now > row.expiresAt) return res.status(400).json({ error: "OTP expired" });
    if (row.attempts >= 5) return res.status(429).json({ error: "Too many attempts" });

    if (row.code !== code) {
      await prisma.otp.update({ where: { phone }, data: { attempts: { increment: 1 } } });
      return res.status(400).json({ error: "Invalid OTP" });
    }

    await prisma.otp.delete({ where: { phone } });

    const role = phone === "8888888888" ? "admin" : "citizen";
    await prisma.user.upsert({ where: { phone }, update: { role }, create: { phone, role } });

    const token = jwt.sign({ phone, role }, JWT_SECRET, { expiresIn: "2h" });
    res.json({ token, role });
  } catch (e) { res.status(500).json({ error: e?.message || "failed" }); }
});

/* ---------- Upload API (auth required) ---------- */
app.post("/upload", auth, (req, res, next) => {
  upload.single("photo")(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message || "upload failed" });
    next();
  });
}, async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "no file" });
    const { filename, mimetype, size } = req.file;
    // return file info (client attaches to issue later)
    res.json({ ok: true, filename, mime: mimetype, size, url: `/uploads/${filename}` });
  } catch (e) {
    res.status(500).json({ error: e?.message || "upload failed" });
  }
});

/* ---------- Create Issue ---------- */
app.post("/issues", auth, async (req, res) => {
  const { category, description = "", coords, attachments = [] } = req.body || {};
  if (!category || !coords || typeof coords.lat !== "number" || typeof coords.lng !== "number") {
    return res.status(400).json({ error: "category and coords {lat,lng} required" });
  }

  const userPhone = req.user?.phone || null;
  const user = userPhone
    ? await prisma.user.upsert({ where: { phone: userPhone }, update: {}, create: { phone: userPhone, role: req.user?.role || "citizen" } })
    : null;

  const issue = await prisma.issue.create({
    data: {
      category,
      description,
      lat: coords.lat,
      lng: coords.lng,
      status: "Created",
      createdById: user?.id
    }
  });

  // persist attachments metadata (if any)
  if (Array.isArray(attachments) && attachments.length) {
    const rows = attachments
      .filter(a => a && a.filename && typeof a.size === "number" && a.mime)
      .map(a => ({ issueId: issue.id, filename: a.filename, mime: a.mime, size: a.size }));
    if (rows.length) await prisma.attachment.createMany({ data: rows });
  }

  await prisma.event.create({ data: { issueId: issue.id, status: "Created", byPhone: userPhone } });

  res.json({ id: issue.id, onchainTx: null });
});

/* ---------- List Issues (with filters) ---------- */
app.get("/issues", auth, async (req, res) => {
  const { status, category, from, to, q } = req.query;

  const where = {};

  if (status) {
    const arr = String(status).split(",").map(s => s.trim()).filter(Boolean);
    if (arr.length) where.status = { in: arr };
  }
  if (category && category !== "All") where.category = String(category);
  if (from || to) {
    where.createdAt = {};
    if (from) where.createdAt.gte = new Date(String(from));
    if (to) { const dt = new Date(String(to)); dt.setHours(23,59,59,999); where.createdAt.lte = dt; }
  }
  if (q) {
    const text = String(q).trim();
    where.OR = [
      { description: { contains: text, mode: "insensitive" } },
      { category:    { contains: text, mode: "insensitive" } }
    ];
  }

  const items = await prisma.issue.findMany({
    where,
    orderBy: { id: "desc" },
    include: { attachments: true }
  });

  const mapped = items.map(i => ({
    id: i.id,
    category: i.category,
    description: i.description,
    status: i.status,
    createdAt: i.createdAt,
    coords: { lat: i.lat, lng: i.lng },
    attachments: i.attachments.map(a => ({
      id: a.id,
      url: `/uploads/${a.filename}`,
      mime: a.mime,
      size: a.size
    }))
  }));

  res.json({ items: mapped, total: mapped.length });
});

/* ---------- Update Status ---------- */
app.post("/issues/:id/status", auth, async (req, res) => {
  const id = Number(req.params.id);
  const { status = "Assigned" } = req.body || {};

  const existing = await prisma.issue.findUnique({ where: { id } });
  if (!existing) return res.status(404).json({ error: "issue not found" });

  await prisma.issue.update({ where: { id }, data: { status } });
  await prisma.event.create({ data: { issueId: id, status, byPhone: req.user?.phone || null } });

  res.json({ ok: true, status });
});


/* ---------- SPA fallback ---------- */
app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

/* ---------- Start ---------- */
app.listen(PORT, () => {
  console.log(`All-in-one server (DEV OTP mode: ${DEV_OTP_MODE ? "ON" : "OFF"}) at http://localhost:${PORT}`);
});