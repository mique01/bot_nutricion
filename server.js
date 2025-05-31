const express = require("express");
const bodyParser = require("body-parser");
const axios = require("axios");
const dotenv = require("dotenv");
const cors = require("cors");
const FormData = require("form-data");
const fs = require("fs");
const path = require("path");
const { v4: uuidv4 } = require("uuid");

dotenv.config();
const app = express();
app.use(cors());
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

const PORT = process.env.PORT || 3000;

app.post("/twilio", async (req, res) => {
  const userInput = req.body.Body || "";
  const mediaUrl = req.body.MediaUrl0 || "";
  const dieta = req.body.dieta || "keto";

  const imageFilePath = `./tmp/${uuidv4()}.jpg`;

  try {
    let messages = [
      {
        role: "system",
        content: `Sos un nutricionista virtual. Respondé de forma breve (no más de 2 renglones) si un alimento es apto para una dieta ${dieta}. Sé conciso.`,
      },
    ];

    let form;

    if (mediaUrl) {
      // Paso 1: Descargar imagen localmente
      const imgResponse = await axios.get(mediaUrl, {
        responseType: "stream",
      });

      await fs.promises.mkdir("./tmp", { recursive: true });
      const writer = fs.createWriteStream(imageFilePath);
      await new Promise((resolve, reject) => {
        imgResponse.data.pipe(writer);
        writer.on("finish", resolve);
        writer.on("error", reject);
      });

      // Paso 2: Armar `multipart/form-data` para OpenAI
      form = new FormData();
      form.append(
        "messages",
        JSON.stringify([
          ...messages,
          {
            role: "user",
            content: [
              { type: "text", text: `¿Puedo comer esto en la dieta ${dieta}?` },
              {
                type: "image_url",
                image_url: { url: "attachment://foto.jpg" },
              },
            ],
          },
        ])
      );
      form.append("model", "gpt-4o");
      form.append("file", fs.createReadStream(imageFilePath), {
        filename: "foto.jpg",
        contentType: "image/jpeg",
      });

      // Paso 3: Enviar a OpenAI
      const response = await axios.post(
        "https://api.openai.com/v1/chat/completions",
        form,
        {
          headers: {
            Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
            ...form.getHeaders(),
          },
        }
      );

      const reply = response.data.choices[0].message.content;
      res.set("Content-Type", "text/plain");
      res.send(reply);
    } else {
      // Texto simple
      messages.push({ role: "user", content: userInput });

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
    }
  } catch (error) {
    console.error("Error:", error?.response?.data || error.message);
    res.status(500).send("Ocurrió un error al procesar la solicitud.");
  } finally {
    // Eliminar archivo temporal si existe
    if (fs.existsSync(imageFilePath)) {
      fs.unlinkSync(imageFilePath);
    }
  }
});

app.get("/", (req, res) => {
  res.send("Bot de nutrición activo 🚀");
});

app.listen(PORT, () => {
  console.log(`Servidor activo en puerto ${PORT}`);
});
