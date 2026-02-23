import express from "express";

const app = express();
const port = 4545;


app.use((req, res) => {
  const { path, body, query } = req;
  console.log({ path, body, query });
  res.send("Hello World!");
});


app.listen(port, () => {
  console.log(`Server started at http://localhost:${port}`);
});
