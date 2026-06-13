require('dotenv').config();
const express = require("express");
const bodyParser = require("body-parser");
const ejs = require("ejs");
const mongoose = require("mongoose");
const dbURL = process.env.MONGODB_URI;
const PORT = process.env.PORT || 3000;

const app = express();
app.set("view engine", "ejs");
app.use(bodyParser.urlencoded({extended: true}));
app.use(express.static("public"));

mongoose.connect(dbURL);

const itemsSchema = new mongoose.Schema({
  itemName: String
});

const listSchema = new mongoose.Schema({
  listName: String,
  listItems: [itemsSchema]
});

const List = mongoose.model("list", listSchema);
const Item = mongoose.model("item", itemsSchema);

// defaut items
const item1 = new Item({
  itemName: "Hello Jimmy"
});

const item2 = new Item({
  itemName: "Have a good day"
});

const item3 = new Item({
  itemName: "Good weather"
});

const defaultItems = [item1, item2, item3];

app.get('/favicon.ico', function(req, res) {
    res.status(204);
    res.end();
});

app.get('/:id', async (req, res, next) => {
  try {
    const customListName = req.params.id;
    const foundList = await List.findOne({ listName: customListName });
    if (!foundList) {
      const newList = new List({
        listName: customListName,
        listItems: defaultItems
      });
      await newList.save();
      return res.redirect("/" + encodeURIComponent(customListName));
    }
    res.render('list', { titlePage: customListName, toDoListItems: foundList.listItems });
  } catch (e) { next(e); }
});


app.get("/", async (req, res, next) => {
  try {
    const foundItems = await Item.find({});
    if (foundItems.length === 0) {
      await Item.insertMany(defaultItems);
      console.log("Item has been created");
      return res.redirect('/');
    }
    res.render("list", { titlePage: "Today", toDoListItems: foundItems });
  } catch (e) { next(e); }
});

app.post('/delete', async (req, res, next) => {
  try {
    const deleteId = req.body.checkbox;
    await Item.findByIdAndDelete(deleteId);
    console.log("Delete done");
    res.redirect('/');
  } catch (e) { next(e); }
});

app.post("/", async (req, res, next) => {
  try {
    const { newItem, list } = req.body;
    const item = new Item({ itemName: newItem });
    if (list === 'Today') {
      await item.save();
      return res.redirect('/');
    }
    const found = await List.findOne({ listName: list });
    if (!found) return res.sendStatus(404);
    found.listItems.push(item);
    await found.save();
    res.redirect('/' + encodeURIComponent(list));
  } catch (e) { next(e); }
});

app.get('/about', function(req, res){
  res.render("about");
})

app.get('/health', (req, res) => res.status(200).send('ok'));

app.listen(PORT, function(){
  console.log("The server is live");
});

module.exports = app;
