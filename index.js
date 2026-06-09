import express from 'express';
import { MongoClient, ServerApiVersion } from 'mongodb';
import dotenv from 'dotenv';
import cors from 'cors';

// Load environment variables from your .env file
dotenv.config();

const app = express();
const port = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(express.json()); // Allows parsing JSON request bodies

// Grab the MongoDB connection string from process.env
const uri = process.env.PASSWORD_DB;

if (!uri) {
  console.error("❌ Error: PASSWORD_DB is not defined in your .env file!");
  process.exit(1);
}

// Create a MongoClient with setup options
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  }
});

async function run() {
  try {
    // Connect the client to the server
    await client.connect();
    
    // Send a ping to confirm a successful connection
    await client.db("admin").command({ ping: 1 });
    console.log("🚀 Pinged your deployment. You successfully connected to MongoDB!");

    // 1. Establish database and collection references
    const db = client.db("Elibrary");
    const booksCollection = db.collection("Books");
// 3. Add the GET endpoint to fetch all books
    app.get('/books', async (req, res) => {
      try {
        // Fetch all documents from the collection and convert them to an array
        const result = await booksCollection.find().toArray();
        
        // Send the array back to your React frontend client
        res.status(200).send(result);
      } catch (error) {
        console.error("Error retrieving books documents:", error);
        res.status(500).send({ error: true, message: "Internal server database error" });
      }
    });
    // 2. Add the POST endpoint to create/publish books
    app.post('/books', async (req, res) => {
      try {
        const newBook = req.body; // Expects layout: { title, imgUrl, email }

        // Basic structural validation
        if (!newBook.title || !newBook.imgUrl || !newBook.email) {
          return res.status(400).send({ 
            error: true, 
            message: "Missing required fields: title, imgUrl, or email." 
          });
        }

        // Add the default status property here
        const bookToInsert = {
          ...newBook,
          status: "available"
        };

        const result = await booksCollection.insertOne(bookToInsert);
        res.status(201).send(result); // Returns { acknowledged: true, insertedId: "..." }
      } catch (error) {
        console.error("Error inserting book document:", error);
        res.status(500).send({ error: true, message: "Internal server database error" });
      }
    });

  } catch (error) {
    console.error("❌ Failed to connect to MongoDB:", error);
  }
}
run().catch(console.dir);

// Root route to check if server is running
app.get('/', (req, res) => {
  res.send('Server is up and running!');
});

// Start listening for requests
app.listen(port, () => {
  console.log(`💻 Server is running on port: ${port}`);
});