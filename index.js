import express from 'express';
import { MongoClient, ServerApiVersion, ObjectId } from 'mongodb';
import dotenv from 'dotenv';
import cors from 'cors';
import cron from 'node-cron';
import nodemailer from 'nodemailer';

dotenv.config();

const app = express();
const port = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());

// ======================
// MongoDB Setup
// ======================
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

// ======================
// EMAIL TRANSPORTER
// ======================
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

// ======================
// MAIN APP
// ======================
async function run() {
  try {
    await client.connect();
    await client.db("admin").command({ ping: 1 });

    console.log("🚀 MongoDB connected");

    await setupTransporter();

    const db = client.db("Elibrary");
    const booksCollection = db.collection("Books");
    const borrowsCollection = db.collection("Borrows");
    const alertsCollection = db.collection("Alerts");

    // ======================
    // GET ALL BOOKS (RESTORED)
    // ======================
    app.get('/books', async (req, res) => {
      try {
        const books = await booksCollection.find().toArray();
        res.send(books);
      } catch (err) {
        res.status(500).send({ message: "Failed to fetch books" });
      }
    });

    // ======================
    // GET SINGLE BOOK
    // ======================
    app.get('/books/:id', async (req, res) => {
      try {
        const id = req.params.id;

        if (!ObjectId.isValid(id)) {
          return res.status(400).send({ message: "Invalid ID" });
        }

        const book = await booksCollection.findOne({ _id: new ObjectId(id) });

        if (!book) {
          return res.status(404).send({ message: "Book not found" });
        }

        res.send(book);
      } catch (err) {
        res.status(500).send({ message: "Server error" });
      }
    });

    // ======================
    // GET USER BOOKS (RESTORED)
    // ======================
    app.get('/my-books', async (req, res) => {
      try {
        const email = req.query.email;

        if (!email) {
          return res.status(400).send({ message: "Email required" });
        }

        const books = await booksCollection.find({ email }).toArray();
        res.send(books);

      } catch (err) {
        res.status(500).send({ message: "Failed to fetch user books" });
      }
    });

    // ======================
    // ADD BOOK (RESTORED)
    // ======================
    app.post('/books', async (req, res) => {
      try {
        const book = req.body;

        if (!book.title || !book.imgUrl || !book.email) {
          return res.status(400).send({ message: "Missing fields" });
        }

        const result = await booksCollection.insertOne({
          ...book,
          status: "available"
        });

        res.status(201).send(result);

      } catch (err) {
        res.status(500).send({ message: "Failed to add book" });
      }
    });

    // ======================
    // BORROW BOOK
    // ======================
    app.post('/borrows', async (req, res) => {
      try {
        const {
          bookId,
          bookTitle,
          lenderEmail,
          borrowerEmail,
          durationDays,
          durationHours,
          durationMinutes
        } = req.body;

        if (!bookId || !lenderEmail || !borrowerEmail) {
          return res.status(400).send({ message: "Missing fields" });
        }

        const book = await booksCollection.findOne({ _id: new ObjectId(bookId) });

        if (!book || book.status !== "available") {
          return res.status(400).send({ message: "Book not available" });
        }

        const totalMinutes =
          (parseInt(durationDays || 0) * 24 * 60) +
          (parseInt(durationHours || 0) * 60) +
          parseInt(durationMinutes || 0);

        if (totalMinutes < 1) {
          return res.status(400).send({ message: "Minimum 1 minute required" });
        }

        const borrowedAt = new Date();
        const dueDate = new Date(borrowedAt.getTime() + totalMinutes * 60000);

        const borrowRecord = {
          bookId: new ObjectId(bookId),
          bookTitle,
          lenderEmail,
          borrowerEmail,
          borrowedAt,
          dueDate,
          status: "active"
        };

        const result = await borrowsCollection.insertOne(borrowRecord);

        await booksCollection.updateOne(
          { _id: new ObjectId(bookId) },
          { $set: { status: "unavailable" } }
        );

        // EMAIL
        if (transporter) {
          try {
            await transporter.sendMail({
              from: '"E-Library" <noreply@elibrary.com>',
              to: borrowerEmail,
              subject: `Book Borrowed: ${bookTitle}`,
              text: `Due: ${dueDate.toLocaleString()}`
            });

            console.log("📧 Borrow email sent");
          } catch (e) {
            console.error("❌ Email failed:", e.message);
          }
        }

        res.status(201).send(result);

      } catch (err) {
        res.status(500).send({ message: "Borrow failed" });
      }
    });

    // ======================
    // EXPIRY CHECK
    // ======================
    const checkExpiredBorrows = async () => {
      try {
        const now = new Date();

        const expired = await borrowsCollection.find({
          dueDate: { $lte: now },
          status: "active"
        }).toArray();

        for (const b of expired) {

          await alertsCollection.insertMany([
            {
              targetUser: b.borrowerEmail,
              message: `Your book "${b.bookTitle}" expired`,
              createdAt: new Date()
            },
            {
              targetUser: b.lenderEmail,
              message: `"${b.bookTitle}" returned`,
              createdAt: new Date()
            }
          ]);

          if (transporter) {
            try {
              await transporter.sendMail({
                from: '"E-Library" <noreply@elibrary.com>',
                to: b.borrowerEmail,
                subject: "Expired",
                text: "Your rental expired"
              });

              await transporter.sendMail({
                from: '"E-Library" <noreply@elibrary.com>',
                to: b.lenderEmail,
                subject: "Returned",
                text: "Book returned"
              });

            } catch (e) {
              console.error("❌ Email error:", e.message);
            }
          }

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

// ======================
// START SERVER (FIXED)
// ======================
run()
  .then(() => {
    app.listen(port, () => {
      console.log(`💻 Server running on port ${port}`);
      console.log(`📧 Email: ${transporter ? "ENABLED" : "DISABLED"}`);
    });
  })
  .catch(console.dir);

// ROOT
app.get('/', (req, res) => {
  res.send("Server running");
});
// PORT=5000
// PASSWORD_DB=mongodb+srv://sussynerd7:sussynerd7@cluster0.07firde.mongodb.net/?appName=Cluster0

// # For Gmail (Recommended - Free)
// SMTP_HOST=smtp.gmail.com
// SMTP_PORT=587
// SMTP_USER=sifatforpc999@gmail.com
// SMTP_PASS=muyq texz bkql vrup