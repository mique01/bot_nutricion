const express = require("express");
const bodyParser = require("body-parser");
const axios = require("axios");
const dotenv = require("dotenv");
const cors = require("cors");

dotenv.config();
const app = express();
app.use(cors());
app.use(bodyParser.json());

const PORT = process.env.PORT || 3000;

// Object to store conversation state for each user (in-memory, reset on server restart)
// For production, use a database (e.g., MongoDB, PostgreSQL)
const conversationStates = {};

// Meta Webhook - Validación inicial
app.get("/webhook", (req, res) => {
  const VERIFY_TOKEN = process.env.VERIFY_TOKEN;

  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("Webhook verificado correctamente ✅");
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// Webhook principal
app.post("/webhook", async (req, res) => {
  const body = req.body;

  if (body.object) {
    const message = body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    const from = message?.from; // número del usuario
    const userInput = message?.text?.body; // Mensaje de texto
    const messageType = message?.type; // Tipo de mensaje (text, image, etc.)

    // Ignore messages from self or status updates
    if (!from || messageType === 'status') return res.sendStatus(200);

    // Get or initialize user state
    if (!conversationStates[from]) {
        conversationStates[from] = { state: "initial" };
    }
    const currentState = conversationStates[from].state;
    const userDiet = conversationStates[from].diet; // Dieta guardada

    console.log(`Message from ${from}: ${userInput || '(Non-text message)'} (State: ${currentState})`);

    try {
      switch (currentState) {
        case "initial":
          // Send the initial welcome message and ask for diet
          await sendWhatsappMessage(from, "¡Hola! Soy tu asistente nutricional 🤖🍎");
          await sendWhatsappMessage(from, "Antes de ayudarte, ¿podés decirme qué tipo de dieta estás siguiendo? Por ejemplo: keto, vegana, sin gluten, hipocalórica, vegetariana.");
          conversationStates[from].state = "waiting_for_diet_response"; // Move to next state
          break;

        case "waiting_for_diet_response":
          // User responds with their diet
          const dietaRespuesta = userInput?.trim();
          if (!dietaRespuesta) { // Handle non-text responses or empty text
              await sendWhatsappMessage(from, "Por favor, indicame el tipo de dieta que seguís o escribí 'ninguna'.");
              // State remains 'waiting_for_diet_response'
          } else {
              // Store the diet and ask for the nutritional query
              conversationStates[from].state = "waiting_for_query";
              conversationStates[from].diet = dietaRespuesta; // Store the diet
              await sendWhatsappMessage(from, `Okay, dieta ${dietaRespuesta} registrada. ¿Qué te gustaría consultar hoy?`);
          }
          break;

        case "waiting_for_query":
          // User provides the nutritional query (text or image)
          let messages = [
            {
              role: "system",
              content: `Eres un nutricionista virtual experto en dietas y composición de alimentos. Responde de forma concisa (no más de 3 frases) y clara si un alimento o platillo es apto para una dieta ${userDiet || 'general'}. **Analiza los ingredientes visibles en la imagen o mencionados en el texto. Si es un carbohidrato, estima su índice glucémico.** Recomienda o no comerlo basándote en la dieta indicada y el análisis. Si no puedes analizar la imagen o el texto, pide más detalles de forma amable.`,
            },
          ];

          let queryContent; // Content for the API (text or image)

          if (messageType === "text") {
            queryContent = userInput;
            if (!queryContent?.trim()) {
                 await sendWhatsappMessage(from, "¿Qué te gustaría consultar hoy? Por favor, escribe tu consulta.");
                 // State remains 'waiting_for_query'
                 break; // Exit switch case
            }
            messages.push({ role: "user", content: queryContent });
          } else if (messageType === "image") {
             const mediaId = message.image.id;
             const imageUrl = await getMediaUrl(mediaId); // Fetch the temporary URL from Meta
             queryContent = [
                 { type: "text", text: `¿Puedo comer esto en la dieta ${userDiet || 'general'}? Por favor, analiza los ingredientes, estima el índice glucémico si aplica, y dime si es apto.` },
                 { type: "image_url", image_url: { url: imageUrl } },
             ];
             messages.push({ role: "user", content: queryContent });
          } else {
             // Handle other unexpected message types
             await sendWhatsappMessage(from, "Por favor, hazme una consulta de texto o envíame una imagen.");
             // State remains 'waiting_for_query'
             break; // Exit switch case
          }

          // Call ChatGPT API (only at this stage)
          const reply = await getGptReply(messages); // This function calls OpenAI
          await sendWhatsappMessage(from, reply);

          // Move to the state asking for another query
          conversationStates[from].state = "waiting_for_another_query";
          await sendWhatsappMessage(from, "¿Quieres hacer otra consulta? (Responde sí o no)");
          break;

        case "waiting_for_another_query":
          // User responds whether they want another query
          const responseOtraConsulta = userInput?.trim().toLowerCase();

          if (responseOtraConsulta === "si" || responseOtraConsulta === "sí") {
            // User wants another query, go back to waiting_for_query state
            conversationStates[from].state = "waiting_for_query";
            await sendWhatsappMessage(from, "¿Qué otra cosa te gustaría consultar hoy?");
          } else if (responseOtraConsulta === "no") {
            // User does not want more queries, end the conversation
            await sendWhatsappMessage(from, "¡Gracias por usar el bot nutricional! Si tienes más dudas, vuelve a escribirme.");
            // Delete the user's state or set it to 'ended'
            delete conversationStates[from]; // Or conversationStates[from].state = "ended";
          } else {
            // Invalid response, ask again
            await sendWhatsappMessage(from, "No entendí tu respuesta. Por favor, responde 'sí' o 'no'.");
            // State remains 'waiting_for_another_query'
          }
          break;

        // You can add other states if needed, e.g., 'ended'
        // case "ended":
        //   // If the bot is in 'ended' state and receives a new message, you might want to restart
        //   await sendWhatsappMessage(from, "Hola de nuevo! ¿En qué puedo ayudarte?");
        //   conversationStates[from] = { state: "initial" };
        //   // Fall through to initial state logic or resend initial message
        //   // break; // Or fall through
        default:
            // Handle unexpected states or reset conversation if needed
            console.warn(`Unknown state for ${from}: ${currentState}. Resetting.`);
            delete conversationStates[from]; // Reset state
            // You might want to send an error message or restart the flow here
            await sendWhatsappMessage(from, "Hubo un problema inesperado. Reiniciando conversación.");
            // Optionally re-send the initial message:
            // await sendWhatsappMessage(from, "¡Hola! Soy tu asistente nutricional 🤖🍎\nAntes de ayudarte, ¿podés decirme qué tipo de dieta estás siguiendo? Por ejemplo: keto, vegana, sin gluten, hipocalórica, vegetariana.");
            break;
      }

      // Send a success response back to Meta/Twilio promptly
      res.sendStatus(200);

    } catch (error) {
      console.error("Error processing message:", error?.response?.data || error.message);
      // In case of any error during processing, send a generic message to the user
      // This is a fallback for errors not caught in specific state logic
      if (from) { // Ensure 'from' is available before sending message
         await sendWhatsappMessage(from, "Lo siento, ocurrió un error al procesar tu solicitud. Intenta de nuevo más tarde.");
      }
      // Optional: you might want to reset the state if the error is severe
      // delete conversationStates[from];
      // Send an error status back to Meta/Twilio if the error occurred before sending a user message
      if (!res.headersSent) {
         res.sendStatus(500);
      }
    }

  } else {
    // Receive other types of notifications from Meta that are not messages
    // For now, simply respond 200 OK
    res.sendStatus(200);
  }
});

// Obtener URL pública de imagen desde Meta
async function getMediaUrl(mediaId) {
  const token = process.env.WHATSAPP_TOKEN;
  if (!token) {
      console.error("WHATSAPP_TOKEN is not set in environment variables.");
      throw new Error("WhatsApp token missing.");
  }
  try {
    const { data } = await axios.get(
      `https://graph.facebook.com/v19.0/${mediaId}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const mediaUrl = data.url;

    // Important: The URL obtained is temporary.
    // For long-term storage or direct use in contexts that don't support auth headers,
    // you would need to download the image and re-upload it to your own storage (like S3, etc.)
    // For now, returning the direct URL which might work for OpenAI Vision depending on their access.
    // If OpenAI cannot access this URL, you will need an intermediate step to host the image publicly.
    // const { data: imageBlob } = await axios.get(mediaUrl, { // This part is not strictly needed to get the URL
    //   headers: { Authorization: `Bearer ${token}` },
    //   responseType: "arraybuffer",
    // });

    console.log(`Fetched media URL for ${mediaId}: ${mediaUrl}`);
    return mediaUrl;

  } catch (error) {
     console.error("Error fetching media URL from Meta:", error?.response?.data || error.message);
     throw new Error("Could not fetch image URL from Meta.");
  }
}

// Enviar mensaje de texto a WhatsApp usando Cloud API
async function sendWhatsappMessage(to, text) {
  const url = `https://graph.facebook.com/v19.0/${process.env.PHONE_NUMBER_ID}/messages`;
  const token = process.env.WHATSAPP_TOKEN;

  if (!process.env.PHONE_NUMBER_ID || !token) {
      console.error("PHONE_NUMBER_ID or WHATSAPP_TOKEN is not set.");
      // Do not throw here, just log, as the main handler will catch and send a user message
      return;
  }

  try {
    await axios.post(
      url,
      {
        messaging_product: "whatsapp",
        to,
        text: { body: text },
        // Removed type: "text" as it's implicitly handled by the text object
      },
      {
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
      }
    );
     console.log(`Message sent to ${to}`);
  } catch (error) {
     console.error(`Error sending message to ${to}:`, error?.response?.data || error.message);
     // Error will be handled by the main try/catch block in the webhook
     throw new Error("Could not send message via WhatsApp API."); // Re-throw the error
  }
}

// Consulta a la API de OpenAI
async function getGptReply(messages) {
  const openaiApiKey = process.env.OPENAI_API_KEY;
   if (!openaiApiKey) {
       console.error("OPENAI_API_KEY is not set in environment variables.");
       throw new Error("OpenAI API key missing.");
   }
  try {
    const response = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      {
        model: "gpt-4o", // Using gpt-4o for vision capabilities, can switch to gpt-3.5-turbo for text-only/lower cost
        messages,
        max_tokens: 300 // Limit the length of the response
      },
      {
        headers: {
          Authorization: `Bearer ${openaiApiKey}`,
          "Content-Type": "application/json",
        },
      }
    );
    // Ensure the response is concise based on the system message
    let reply = response.data.choices[0].message.content;
    // You might add additional logic here to truncate if needed, but relying on max_tokens and prompt is better
    console.log("Received reply from OpenAI.");
    return reply;

  } catch (error) {
    console.error("Error calling OpenAI API:", error?.response?.data || error.message);
    // Re-throw the error so the main webhook handler can catch it and send a user-friendly message
    throw new Error("Error al obtener respuesta de la IA.");
  }
}

// Root endpoint - simple check
app.get("/", (req, res) => {
  res.send("🧠 Bot de nutrición activo con Meta Cloud API 🚀");
});

// Start the server
app.listen(PORT, () => {
  console.log(`Servidor corriendo en puerto ${PORT}`);
});
