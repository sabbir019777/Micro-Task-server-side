const express = require("express");
const app = express();
const cors = require("cors");
const jwt = require("jsonwebtoken");
require("dotenv").config();
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");

const port = process.env.PORT || 5000;

// Middlewares

app.use(cors());
app.use(express.json());

// MongoDB URi
const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.5u4x9tc.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0`;


const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});




async function run() {
  try {

    await client.connect();


    const db = client.db("micro-earning-platform-v2"); 
    
    console.log("✅ Currently Connected to DB:", db.databaseName); 

    const usersCollection = db.collection("users");
    const tasksCollection = db.collection("tasks");
    const submissionsCollection = db.collection("submissions");
    const withdrawalsCollection = db.collection("withdrawals");
    const paymentsCollection = db.collection("payments");
    const notificationsCollection = db.collection("notifications");

   
    //  JWT & AUTHENTICATION

    app.post("/jwt", async (req, res) => {
      const user = req.body;
      const token = jwt.sign(user, process.env.ACCESS_TOKEN_SECRET, { expiresIn: "1h" });
      res.send({ token });
    });

    const verifyToken = (req, res, next) => {
      if (!req.headers.authorization) {
        return res.status(401).send({ message: "unauthorized access" });
      }
      const token = req.headers.authorization.split(" ")[1];
      jwt.verify(token, process.env.ACCESS_TOKEN_SECRET, (err, decoded) => {
        if (err) {
          return res.status(401).send({ message: "unauthorized access" });
        }
        req.decoded = decoded;
        next();
      });
    };

    const verifyAdmin = async (req, res, next) => {
      const email = req.decoded.email;
      const user = await usersCollection.findOne({ email });
      if (user?.role !== "admin") {
        return res.status(403).send({ message: "forbidden access" });
      }
      next();
    };

    //  BEST WORKERS API

    app.get("/best-workers", async (req, res) => {
      try {
        const result = await usersCollection
          .find({ role: "worker" })
          .sort({ coin: -1 })
          .limit(8) 
          .toArray();
        res.send(result);
      } catch (error) {
        console.error("Error fetching workers:", error);
        res.status(500).send({ message: "Failed to fetch workers" });
      }
    });


    //  USER MANAGEMENT

    app.post("/users", async (req, res) => {
      const user = req.body;
      const existingUser = await usersCollection.findOne({ email: user.email });
      if (existingUser) {
        return res.send({ message: "user already exists", insertedId: null });
      }
      let initialCoin = user.role === "worker" ? 10 : user.role === "buyer" ? 50 : 0;
      const result = await usersCollection.insertOne({
        ...user,
        coin: initialCoin,
        timestamp: new Date(),
      });
      res.send(result);
    });

    app.get("/users/:email", verifyToken, async (req, res) => {
      const result = await usersCollection.findOne({ email: req.params.email });
      res.send(result);
    });

    app.get("/users", verifyToken, verifyAdmin, async (req, res) => {
      const result = await usersCollection.find().toArray();
      res.send(result);
    });

    app.patch("/users/role/:id", verifyToken, verifyAdmin, async (req, res) => {
      const result = await usersCollection.updateOne(
        { _id: new ObjectId(req.params.id) },
        { $set: { role: req.body.role } }
      );
      res.send(result);
    });

    app.delete("/users/:id", verifyToken, verifyAdmin, async (req, res) => {
      const result = await usersCollection.deleteOne({ _id: new ObjectId(req.params.id) });
      res.send(result);
    });


    
    //  TASK & SUBMISSION MANAGEMENT

    app.post("/tasks", verifyToken, async (req, res) => {
      const task = req.body;
      const requiredCoin = task.required_workers * task.payable_amount;
      const buyer = await usersCollection.findOne({ email: task.buyer_email });
      
      if (buyer.coin < requiredCoin) {
        return res.status(400).send({ message: "Not enough coins" });
      }


      await usersCollection.updateOne(
        { email: task.buyer_email },
        { $inc: { coin: -requiredCoin } }
      );
      const result = await tasksCollection.insertOne(task);
      res.send(result);
    });

    app.get("/tasks", async (req, res) => {

      const result = await tasksCollection.find({ required_workers: { $gt: 0 } }).toArray();
      res.send(result);
    });

    app.get("/task/:id", verifyToken, async (req, res) => {
      const result = await tasksCollection.findOne({ _id: new ObjectId(req.params.id) });
      res.send(result);
    });

    app.get("/my-tasks/:email", verifyToken, async (req, res) => {
      const result = await tasksCollection
        .find({ buyer_email: req.params.email })
        .sort({ completion_date: -1 })
        .toArray();
      res.send(result);
    });

    app.delete("/tasks/:id", verifyToken, async (req, res) => {
      const id = req.params.id;
      const task = await tasksCollection.findOne({ _id: new ObjectId(id) });
      if (!task) return res.status(404).send({ message: "Task not found" });


      const refillAmount = task.required_workers * task.payable_amount;
      await usersCollection.updateOne(
        { email: task.buyer_email },
        { $inc: { coin: refillAmount } }
      );
      const result = await tasksCollection.deleteOne({ _id: new ObjectId(id) });
      res.send(result);
    });

 
    app.post("/submissions", verifyToken, async (req, res) => {
      const submission = req.body;
      

      const result = await submissionsCollection.insertOne(submission);
      
 
      if (submission.task_id) {
        await tasksCollection.updateOne(
            { _id: new ObjectId(submission.task_id) },
            { $inc: { required_workers: -1 } }
        );
      }
      
      res.send(result);
    });

    app.delete("/submissions/:id", verifyToken, async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const result = await submissionsCollection.deleteOne(query);
      res.send(result);
    });

    app.get("/my-submissions/:email", verifyToken, async (req, res) => {
      const result = await submissionsCollection.find({ worker_email: req.params.email }).toArray();
      res.send(result);
    });

    app.get("/buyer-submissions/:email", verifyToken, async (req, res) => {
      const result = await submissionsCollection
        .find({ buyer_email: req.params.email, status: "pending" })
        .toArray();
      res.send(result);
    });

    app.patch("/submissions/approve/:id", verifyToken, async (req, res) => {
      const id = req.params.id;
      const submission = await submissionsCollection.findOne({ _id: new ObjectId(id) });
      
      await submissionsCollection.updateOne(
        { _id: new ObjectId(id) },
        { $set: { status: "approved" } }
      );
      
 
      await usersCollection.updateOne(
        { email: submission.worker_email },
        { $inc: { coin: submission.payable_amount } }
      );


      await notificationsCollection.insertOne({
        message: `Earned ${submission.payable_amount} coins from ${submission.task_title}`,
        toEmail: submission.worker_email,
        time: new Date(),
      });
      res.send({ message: "approved" });
    });

    app.patch("/submissions/reject/:id", verifyToken, async (req, res) => {
      const id = req.params.id;
      const submission = await submissionsCollection.findOne({ _id: new ObjectId(id) });
      
      await submissionsCollection.updateOne(
        { _id: new ObjectId(id) },
        { $set: { status: "rejected" } }
      );
      
    
      await tasksCollection.updateOne(
        { _id: new ObjectId(submission.task_id) },
        { $inc: { required_workers: 1 } }
      );

      await notificationsCollection.insertOne({
        message: `Your submission for ${submission.task_title} was rejected.`,
        toEmail: submission.worker_email,
        time: new Date(),
      });
      res.send({ message: "rejected" });
    });


    // 💳 PAYMENT & STATS
  
    app.post("/create-payment-intent", verifyToken, async (req, res) => {
      const { price } = req.body;
      const amount = parseInt(price * 100);
      const paymentIntent = await stripe.paymentIntents.create({
        amount: amount,
        currency: "usd",
        payment_method_types: ["card"],
      });
      res.send({ clientSecret: paymentIntent.client_secret });
    });

    app.post("/payments", verifyToken, async (req, res) => {
      const payment = req.body;
      const price = parseFloat(payment.price);
      let coinsToAdd = 0;
      if (price === 1) coinsToAdd = 10;
      else if (price === 10) coinsToAdd = 150;
      else if (price === 20) coinsToAdd = 500;
      else if (price === 35) coinsToAdd = 1000;

      await usersCollection.updateOne(
        { email: payment.email },
        { $inc: { coin: coinsToAdd } }
      );
      const result = await paymentsCollection.insertOne(payment);
      res.send(result);
    });

    app.get("/payment-history/:email", verifyToken, async (req, res) => {
      const result = await paymentsCollection
        .find({ email: req.params.email })
        .sort({ date: -1 })
        .toArray();
      res.send(result);
    });

    app.post("/withdrawals", verifyToken, async (req, res) => {
      const result = await withdrawalsCollection.insertOne(req.body);
      res.send(result);
    });

    app.get("/admin/withdrawals", verifyToken, verifyAdmin, async (req, res) => {
      const result = await withdrawalsCollection.find({ status: "pending" }).toArray();
      res.send(result);
    });

    app.patch("/withdrawals/approve/:id", verifyToken, verifyAdmin, async (req, res) => {
      const id = req.params.id;
      const withdrawal = await withdrawalsCollection.findOne({ _id: new ObjectId(id) });
      
      await withdrawalsCollection.updateOne(
        { _id: new ObjectId(id) },
        { $set: { status: "approved" } }
      );
      
      await usersCollection.updateOne(
        { email: withdrawal.worker_email },
        { $inc: { coin: -withdrawal.withdrawal_coin } }
      );

      await notificationsCollection.insertOne({
        message: `Your withdrawal of ${withdrawal.withdrawal_coin} coins has been approved.`,
        toEmail: withdrawal.worker_email,
        time: new Date(),
      });

      res.send({ message: "Withdrawal Approved" });
    });

    app.get("/buyer-stats/:email", verifyToken, async (req, res) => {
      const email = req.params.email;
      const totalTasks = await tasksCollection.countDocuments({ buyer_email: email });
      const myTasks = await tasksCollection.find({ buyer_email: email }).toArray();
      const pendingWorkers = myTasks.reduce((sum, t) => sum + (t.required_workers || 0), 0);
      
      const payments = await paymentsCollection.find({ email: email }).toArray();
      const totalPaid = payments.reduce((sum, p) => sum + parseFloat(p.price || 0), 0);
      
      res.send({ totalTasks, pendingWorkers, totalPaid });
    });

    app.get("/worker-stats/:email", verifyToken, async (req, res) => {
      const email = req.params.email;
      const totalSubmissions = await submissionsCollection.countDocuments({ worker_email: email });
      const pendingSubmissions = await submissionsCollection.countDocuments({
        worker_email: email,
        status: "pending",
      });
      const approvedSubmissions = await submissionsCollection
        .find({ worker_email: email, status: "approved" })
        .toArray();
      const totalEarning = approvedSubmissions.reduce((sum, sub) => sum + (sub.payable_amount || 0), 0);
      
      res.send({ totalSubmissions, pendingSubmissions, totalEarning });
    });

    app.get("/admin-stats", verifyToken, verifyAdmin, async (req, res) => {
      const totalWorkers = await usersCollection.countDocuments({ role: "worker" });
      const totalBuyers = await usersCollection.countDocuments({ role: "buyer" });
      
      const coins = await usersCollection
        .aggregate([{ $group: { _id: null, total: { $sum: "$coin" } } }])
        .toArray();
        
      const earnings = await paymentsCollection
        .aggregate([{ $group: { _id: null, total: { $sum: "$price" } } }])
        .toArray();

      res.send({
        totalWorkers,
        totalBuyers,
        totalCoin: coins[0]?.total || 0,
        totalEarnings: earnings[0]?.total || 0,
      });
    });

    app.get("/notifications/:email", verifyToken, async (req, res) => {
      const result = await notificationsCollection
        .find({ toEmail: req.params.email })
        .sort({ time: -1 })
        .limit(20) 
        .toArray();
      res.send(result);
    });

  
    await client.db("admin").command({ ping: 1 });
    console.log("✅ Pinged your deployment. You successfully connected to MongoDB!");

    app.get("/", (req, res) => {
      res.send("Micro-Task Server Running...");
    });

  } finally {
    
  }
}
run().catch(console.dir);

app.listen(port, () => console.log(`Server running on port ${port}`));