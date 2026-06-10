import express from 'express';
import { MongoClient, ServerApiVersion, ObjectId } from 'mongodb';
import dotenv from 'dotenv';
import cors from 'cors';
import cron from 'node-cron';
import nodemailer from 'nodemailer';

dotenv.config();

const app = express();
const port = process.env.PORT || 5000;

// ✅ Bulletproof Manual CORS Middleware for Vercel
// ✅ Bulletproof Manual CORS Middleware allowing multiple origins
app.use(cors({ 
  origin: [
    'https://elibrary-d76cc.web.app', // Your production frontend
    'http://localhost:5173'           // Your local Vite development frontend
  ] 
}));
//how to add another second origin like ,'http://localhost:5173'
app.use(express.json());

const uri = process.env.PASSWORD_DB;

if (!uri) {
  console.error("❌ PASSWORD_DB is missing in .env");
  process.exit(1);
}

const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  }
});

let transporter;

const setupTransporter = async () => {
  try {
    if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
      console.warn("⚠️ SMTP not configured");
      return;
    }

    transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
    });

    await transporter.verify();
    console.log("✅ SMTP configured successfully!");

  } catch (error) {
    console.error("❌ SMTP failed:", error.message);
    transporter = null;
  }
};

// ─── helpers ────────────────────────────────────────────────────────────────

const formatDate = (date) =>
  date.toLocaleString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });

const sendMail = async (to, subject, html) => {
  if (!transporter) return;
  try {
    await transporter.sendMail({
      from: '"E-Library 📚" <noreply@elibrary.com>',
      to,
      subject,
      html,
    });
    console.log(`📧 Email sent to ${to}`);
  } catch (e) {
    console.error(`❌ Email to ${to} failed:`, e.message);
  }
};

// ─── main ────────────────────────────────────────────────────────────────────

async function run() {
  try {
    await client.connect();
    await client.db("admin").command({ ping: 1 });
    console.log("🚀 MongoDB connected");

    await setupTransporter();

    const db = client.db("Elibrary");
    const booksCollection  = db.collection("Books");
    const borrowsCollection = db.collection("Borrows");
    const alertsCollection  = db.collection("Alerts");

    // ── ROOT ROUTE ─────────────────────────────────────────────────────────
    app.get('/', (req, res) => res.send("Server running"));

    // ── GET ALL BOOKS ──────────────────────────────────────────────────────
    app.get('/books', async (req, res) => {
      try {
        const books = await booksCollection.find().toArray();
        res.send(books);
      } catch {
        res.status(500).send({ message: "Failed to fetch books" });
      }
    });

    // ── GET SINGLE BOOK ────────────────────────────────────────────────────
    app.get('/books/:id', async (req, res) => {
      try {
        const id = req.params.id;
        if (!ObjectId.isValid(id)) return res.status(400).send({ message: "Invalid ID" });

        const book = await booksCollection.findOne({ _id: new ObjectId(id) });
        if (!book) return res.status(404).send({ message: "Book not found" });

        res.send(book);
      } catch {
        res.status(500).send({ message: "Server error" });
      }
    });

    // ── GET USER BOOKS ─────────────────────────────────────────────────────
    app.get('/my-books', async (req, res) => {
      try {
        const email = req.query.email;
        if (!email) return res.status(400).send({ message: "Email required" });

        const books = await booksCollection.find({ email }).toArray();
        res.send(books);
      } catch {
        res.status(500).send({ message: "Failed to fetch user books" });
      }
    });

    // ── ADD BOOK ───────────────────────────────────────────────────────────
    app.post('/books', async (req, res) => {
      try {
        const book = req.body;
        if (!book.title || !book.imgUrl || !book.email) {
          return res.status(400).send({ message: "Missing fields" });
        }

        const result = await booksCollection.insertOne({ ...book, status: "available" });
        res.status(201).send(result);
      } catch {
        res.status(500).send({ message: "Failed to add book" });
      }
    });

    // ── BORROW BOOK ────────────────────────────────────────────────────────
    app.post('/borrows', async (req, res) => {
      try {
        const {
          bookId,
          bookTitle,
          lenderEmail,
          lenderName,
          borrowerEmail,
          borrowerName,
          durationDays,
          durationHours,
          durationMinutes,
        } = req.body;

        if (!bookId || !lenderEmail || !borrowerEmail) {
          return res.status(400).send({ message: "Missing fields" });
        }

        const book = await booksCollection.findOne({ _id: new ObjectId(bookId) });
        if (!book || book.status !== "available") {
          return res.status(400).send({ message: "Book not available" });
        }

        const totalMinutes =
          (parseInt(durationDays    || 0) * 24 * 60) +
          (parseInt(durationHours   || 0) * 60) +
           parseInt(durationMinutes || 0);

        if (totalMinutes < 1) {
          return res.status(400).send({ message: "Minimum 1 minute required" });
        }

        const borrowedAt = new Date();
        const dueDate    = new Date(borrowedAt.getTime() + totalMinutes * 60000);

        const borrowRecord = {
          bookId: new ObjectId(bookId),
          bookTitle,
          lenderEmail,
          lenderName:    lenderName    || "Lender",
          borrowerEmail,
          borrowerName:  borrowerName  || "Borrower",
          borrowedAt,
          dueDate,
          status: "active",
        };

        const result = await borrowsCollection.insertOne(borrowRecord);

        await booksCollection.updateOne(
          { _id: new ObjectId(bookId) },
          { $set: { status: "unavailable" } }
        );

        const dueDateStr = formatDate(dueDate);

        // ── email to LENDER ──────────────────
        await sendMail(
          lenderEmail,
          `📖 Your book "${bookTitle}" has been borrowed`,
          `
            <p>Hey <strong>${lenderName || "there"}</strong>,</p>
            <p>Your book <strong>"${bookTitle}"</strong> has been borrowed by
            <strong>${borrowerName || borrowerEmail}</strong>.</p>
            <p>They are expected to return it by:</p>
            <p style="font-size:16px; font-weight:bold;">${dueDateStr}</p>
            <p>You'll receive another email once the lending period ends.</p>
            <br/>
            <p>— E-Library Team</p>
          `
        );

        // ── email to BORROWER ──────
        await sendMail(
          borrowerEmail,
          `✅ You borrowed "${bookTitle}" — return by ${dueDateStr}`,
          `
            <p>Hi <strong>${borrowerName || "there"}</strong>,</p>
            <p>You have successfully borrowed <strong>"${bookTitle}"</strong>.</p>
            <p>Please make sure to return it by:</p>
            <p style="font-size:16px; font-weight:bold;">${dueDateStr}</p>
            <p>Enjoy your reading! 📚</p>
            <br/>
            <p>— E-Library Team</p>
          `
        );

        res.status(201).send(result);

      } catch (err) {
        console.error(err);
        res.status(500).send({ message: "Borrow failed" });
      }
    });

    // ── GET ALERTS FOR USER ────────────────────────────────────────────────
    app.get('/alerts', async (req, res) => {
      try {
        const email = req.query.email;
        if (!email) return res.status(400).send({ message: "Email required" });

        const alerts = await alertsCollection
          .find({ targetUser: email })
          .sort({ createdAt: -1 })
          .limit(20)
          .toArray();

        res.send(alerts);
      } catch {
        res.status(500).send({ message: "Failed to fetch alerts" });
      }
    });

    // ── MARK ALERT AS READ ─────────────────────────────────────────────────
    app.patch('/alerts/:id/read', async (req, res) => {
      try {
        if (!ObjectId.isValid(req.params.id)) {
          return res.status(400).send({ message: "Invalid ID" });
        }
        await alertsCollection.updateOne(
          { _id: new ObjectId(req.params.id) },
          { $set: { read: true } }
        );
        res.send({ ok: true });
      } catch {
        res.status(500).send({ message: "Failed to update alert" });
      }
    });

    // ── CRON: CHECK EXPIRED BORROWS ────────────────────────────────────────
    const checkExpiredBorrows = async () => {
      try {
        const now = new Date();

        const expired = await borrowsCollection.find({
          dueDate: { $lte: now },
          status: "active",
        }).toArray();

        for (const b of expired) {

          // in-app alerts for both sides
          await alertsCollection.insertMany([
            {
              targetUser: b.lenderEmail,
              message: `The lending period for your book "${b.bookTitle}" has ended. ${b.borrowerName || b.borrowerEmail} is supposed to return it to you.`,
              type: "lending_expired",
              read: false,
              createdAt: new Date(),
            },
            {
              targetUser: b.borrowerEmail,
              message: `Your borrowing period for "${b.bookTitle}" has expired. Please return it to ${b.lenderName || b.lenderEmail} as soon as possible.`,
              type: "return_due",
              read: false,
              createdAt: new Date(),
            },
          ]);

          // expiry email to LENDER
          await sendMail(
            b.lenderEmail,
            `⏰ Lending period ended — "${b.bookTitle}"`,
            `
              <p>Hi <strong>${b.lenderName || "there"}</strong>,</p>
              <p>The borrowing period for your book <strong>"${b.bookTitle}"</strong> has run out.</p>
              <p><strong>${b.borrowerName || b.borrowerEmail}</strong> is supposed to return your book to you now.</p>
              <p>If you haven't heard from them, feel free to reach out at: <a href="mailto:${b.borrowerEmail}">${b.borrowerEmail}</a></p>
              <br/>
              <p>— E-Library Team</p>
            `
          );

          // expiry email to BORROWER
          await sendMail(
            b.borrowerEmail,
            `📬 Time's up — please return "${b.bookTitle}"`,
            `
              <p>Hi <strong>${b.borrowerName || "there"}</strong>,</p>
              <p>Your borrowing period for <strong>"${b.bookTitle}"</strong> has officially expired.</p>
              <p>Please return the book to <strong>${b.lenderName || b.lenderEmail}</strong> as soon as possible.</p>
              <p>Keeping a borrowed book beyond the agreed time is unfair to the lender who trusted you with it.🙏</p>
              <br/>
              <p>— E-Library Team</p>
            `
          );

          // mark expired + free the book
          await borrowsCollection.updateOne(
            { _id: b._id },
            { $set: { status: "expired" } }
          );

          await booksCollection.updateOne(
            { _id: b.bookId },
            { $set: { status: "available" } }
          );
        }

      } catch (err) {
        console.error("Cron error:", err);
      }
    };

    cron.schedule("* * * * *", checkExpiredBorrows);
    console.log("⏰ Cron running every minute");

  } catch (err) {
    console.error("Mongo error:", err);
  }
}

run()
  .then(() => {
    app.listen(port, () => {
      console.log(`💻 Server running on port ${port}`);
      console.log(`📧 Email: ${transporter ? "ENABLED" : "DISABLED"}`);
    });
  })
  .catch(console.dir);