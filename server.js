// server.js
const express = require("express");
const bodyParser = require("body-parser");
const axios = require("axios");
const dotenv = require("dotenv");
const cors = require("cors");

dotenv.config();
const app = express();
app.use(cors());
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

const PORT = process.env.PORT || 3000;

app.post("/twilio", async (req, res) => {
  const userInput = req.body.Body || "";
  const mediaUrl = req.body.MediaUrl0 || "";
  const dieta = req.body.dieta || "keto"; // opcional: podés guardar esto con una base

  let messages = [
    {
      role: "system",
      content: `Sos un nutricionista virtual. Respondé con claridad si un alimento es apto para una dieta ${dieta}.`,
    },
  ];

  if (mediaUrl) {
    // Mensaje con imagen
    messages.push({
      role: "user",
      content: [
        { type: "text", text: `¿Puedo comer esto en la dieta ${dieta}?` },
        {
          type: "image_url",
          image_url: { url: mediaUrl },
        },
      ],
    });
  } else {
    // Solo texto
    messages.push({
      role: "user",
      content: userInput,
    });
  }

  try {
    const response = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      {
        model: "gpt-4o",
        messages,
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },
      }
    );

    const reply = response.data.choices[0].message.content;
    res.set("Content-Type", "text/plain");
    res.send(reply);

  } catch (error) {
    console.error(error?.response?.data || error.message);
    res.status(500).send("Ocurrió un error al procesar la solicitud.");
  }
});

app.get("/", (req, res) => {
  res.send("Bot de nutrición activo 🚀");
});

app.listen(PORT, () => {
  console.log(`Servidor activo en puerto ${PORT}`);
});
