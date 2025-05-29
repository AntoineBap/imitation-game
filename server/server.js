const express = require("express");
const http = require("http");
const socketIo = require("socket.io");
const multer = require("multer");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const ffmpeg = require("fluent-ffmpeg")
require("dotenv").config();

const app = express();
app.use(
  cors({
    origin: process.env.FRONTEND_ORIGIN || "*",
    methods: ["GET", "POST"],
    credentials: true,
  })
);
app.use("/uploads", express.static(path.join(__dirname, "uploads")));
app.use(express.static("public"));

const server = http.createServer(app);
const io = socketIo(server, { cors: { origin: "*" } });

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(__dirname, "uploads");
    fs.mkdirSync(dir, { recursive: true }); 
    cb(null, dir);
  },
  filename: (req, file, cb) =>
    cb(null, Date.now() + "-" + Math.round(Math.random() * 1e9) + ".webm"),
});


const upload = multer({ storage });

let rooms = {}; // roomId: { players, recordings, hostId, validated, clipIndex }

function playNextClip(roomId) {
  const room = rooms[roomId];
  if (!room) return;

  const roomDir = path.join(__dirname, "public", roomId);

  // Si c'est le premier clip, on charge la liste des fichiers .mp4
  if (!room.clipIndex) {
    room.clipIndex = 0;
    try {
      const files = fs.readdirSync(roomDir).filter((f) => f.endsWith(".mp4"));
      room.clips = files;

      // Tri facultatif par date (si tu veux reproduire l'ordre d'upload)
      // files.sort((a, b) => fs.statSync(path.join(roomDir, a)).mtimeMs - fs.statSync(path.join(roomDir, b)).mtimeMs);
    } catch (e) {
      console.error(
        `❌ Impossible de lire les clips pour la room ${roomId}`,
        e
      );
      return;
    }

    // Initialise les scores
    room.scores = {};
    for (const playerId of room.players.keys()) {
      room.scores[playerId] = 0;
    }

    const scoresByName = {};
    for (const [socketId, score] of Object.entries(room.scores)) {
      const name = room.players.get(socketId);
      if (name) scoresByName[name] = score;
    }

    io.to(roomId).emit("update_scores", scoresByName);
  }

  if (room.clipIndex >= room.clips.length) {
    io.to(roomId).emit("game_over");
    return;
  }

  const clipName = room.clips[room.clipIndex];

  const phase = room.clipIndex === 0 ? "waiting_start" : "playing_clip";
  io.to(roomId).emit("phase_change", phase);
  io.to(roomId).emit("play_clip", { clipName });
  io.to(roomId).emit("phase_change", "playing_clip");

  room.recordings = {};
  room.validated = new Set();

  room.clipIndex++;
}

io.on("connection", (socket) => {
  socket.on("create_room", ({ name }, callback) => {
    let code;
    do {
      code = Math.floor(100000 + Math.random() * 900000).toString();
    } while (rooms[code]);

    rooms[code] = {
      players: new Map(),
      hostId: socket.id,
      recordings: {},
      validated: new Set(),
      clipIndex: 0,
      scores: {},
      clips: [],
    };

    socket.join(code);
    rooms[code].players.set(socket.id, name);

    io.to(code).emit("update_players", {
      names: Object.fromEntries(rooms[code].players),
      hostId: socket.id,
    });

    callback({ success: true, roomId: code });
  });

  socket.on("join_room", ({ code, name }, callback) => {
    const room = rooms[code];
    if (!room) {
      return callback({ success: false, error: "Room not found" });
    }

    socket.join(code);
    room.players.set(socket.id, name);

    io.to(code).emit("update_players", {
      names: Object.fromEntries(room.players),
      hostId: room.hostId,
    });

    callback({ success: true, roomId: code });

    if (room.players.size >= 2) {
      io.to(code).emit("phase_change", "waiting_start");
    }
  });

  socket.on("host_start_clip", (roomId) => {
    playNextClip(roomId);
  });

  socket.on("clip_done", (roomId) => {
    io.to(roomId).emit("start_recording");
  });

  socket.on("all_votes_in", (roomId) => {
    io.to(roomId).emit("start_countdown", { seconds: 3 });

    setTimeout(() => {
      io.to(roomId).emit("next_audio");
    }, 3000);
  });

  socket.on("recording_done", ({ roomId, blobName }) => {
    const room = rooms[roomId];
    if (!room) return;

    room.recordings[socket.id] = blobName;
    room.validated.add(socket.id);

    io.to(roomId).emit("update_validations", {
      count: room.validated.size,
      total: room.players.size,
    });

    if (room.validated.size === room.players.size) {
      io.to(roomId).emit("play_recordings", room.recordings);
    }
  });

  socket.on("request_button_countdown", ({ roomId, action }) => {
    io.to(roomId).emit("start_button_countdown", { action });
  });

  socket.on("host_start_votes", (roomId) => {
    const room = rooms[roomId];
    if (!room || socket.id !== room.hostId) return;

    const voteQueue = Array.from(room.players.keys()).filter((id) =>
      room.recordings.hasOwnProperty(id)
    );

    room.voteQueue = voteQueue;
    room.currentVoteIndex = 0;
    room.votes = {};

    const firstVoterId = voteQueue[0];
    const firstRecording = room.recordings[firstVoterId];

    io.to(roomId).emit("start_vote_phase", {
      voterId: firstVoterId,
      filename: firstRecording,
    });
  });

  socket.on("vote", ({ roomId, targetId, note }) => {
    const room = rooms[roomId];
    if (!room) return;
    if (!room.votes[targetId]) room.votes[targetId] = [];
    // refuse le vote si le voteur a deja vote pour ce joueur
    if (room.votes[targetId].some((v) => v.voter === socket.id)) return;
    room.votes[targetId].push({ voter: socket.id, note });
    const expectedVotes = room.players.size - 1;

    if (room.votes[targetId].length === expectedVotes) {
      const total = room.votes[targetId].reduce((sum, v) => sum + v.note, 0);
      room.scores[targetId] = (room.scores[targetId] || 0) + total;

      // emets les scores
      const scoresByName = {};
      for (const [socketId, score] of Object.entries(room.scores)) {
        const name = room.players.get(socketId);
        if (name) scoresByName[name] = score;
      }
      io.to(roomId).emit("update_scores", scoresByName);

      // passe au prochain vote
      room.currentVoteIndex++;
      if (room.currentVoteIndex < room.voteQueue.length) {
        const nextId = room.voteQueue[room.currentVoteIndex];
        const nextRec = room.recordings[nextId];
        io.to(roomId).emit("start_countdown", { seconds: 3 });
        setTimeout(() => {
          io.to(roomId).emit("start_vote_phase", {
            voterId: nextId,
            filename: nextRec,
          });
        }, 3000);
      } else {
        io.to(roomId).emit("voting_done", room.votes);
      }
    }
  });

  socket.on("host_next_clip", (roomId) => {
    const room = rooms[roomId];
    if (!room || socket.id !== room.hostId) return;

    // supprime les anciens fichiers d'enregistrements
    for (const blobName of Object.values(room.recordings)) {
      const filePath = path.join(__dirname, "uploads", blobName);
      fs.unlink(filePath, (err) => {
        if (err) console.error("❌ Erreur suppression fichier:", filePath, err);
        else console.log("🗑️ Fichier supprimé:", filePath);
      });
    }

    // reinitialise l'etat de la room
    room.recordings = {};
    room.validated = new Set();
    room.voteQueue = [];
    room.currentVoteIndex = 0;
    room.votes = {};

    if (room.clipIndex >= room.clips.length) {
      // vide le dossier uploads et les clips de la room en fin de game
      const roomDir = path.join(__dirname, "public", roomId);
      const uploadsDir = path.join(__dirname, "uploads");
      fs.readdir(uploadsDir, (err, files) => {
        if (err) return console.error("Erreur lecture uploads:", err);
        for (const file of files) {
          fs.unlink(path.join(uploadsDir, file), (err) => {
            if (err) console.error("Erreur suppression fichier:", file, err);
          });
        }
      });

      fs.rm(roomDir, { recursive: true, force: true }, (err) => {
        if (err)
          console.error("❌ Erreur suppression dossier room:", roomDir, err);
        else console.log("🗑️ Dossier room supprimé:", roomDir);
      });

      // Envoie game over
      io.to(roomId).emit("game_over");
      return; // pour ne pas appeler playNextClip après
    }

    // lance le prochain clip
    playNextClip(roomId);
  });

  socket.on("disconnect", () => {
    for (const roomId in rooms) {
      const room = rooms[roomId];
      if (room.players.has(socket.id)) {
        room.players.delete(socket.id);
        if (room.players.size === 0) {
          delete rooms[roomId];
        } else {
          if (room.hostId === socket.id) {
            room.hostId = [...room.players.keys()][0];
          }
          io.to(roomId).emit("update_players", {
            names: Object.fromEntries(room.players),
            hostId: room.hostId,
          });
        }
      }
    }
  });
});

const videoStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const roomId = req.query.roomId;
    console.log("➡️ Destination appelée, roomId =", roomId);
    if (!roomId) return cb(new Error("Room ID manquant"), null);
    const dir = path.join(__dirname, "public", roomId);
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    const uniqueName = Date.now() + "-" + Math.round(Math.random() * 1e9) + ext;
    cb(null, uniqueName);
  },
});

const videoUpload = multer({
  storage: videoStorage,
  limits: { fileSize: 50 * 1024 * 1024 }, // 50 Mo max
  fileFilter: (req, file, cb) => {
    if (file.mimetype !== "video/mp4") {
      return cb(new Error("Seuls les fichiers .mp4 sont autorisés"));
    }
    cb(null, true);
  },
});

app.post("/upload_clip", (req, res) => {
  videoUpload.array("clips", 10)(req, res, function (err) {
    const roomId = req.query?.roomId;
    console.log("📥 Upload multiple déclenché pour room:", roomId);

    if (err instanceof multer.MulterError) {
      if (err.code === "LIMIT_FILE_SIZE") {
        return res
          .status(413)
          .json({ error: "Fichier trop volumineux (max 50 Mo)" });
      }
      return res.status(400).json({ error: err.message });
    } else if (err) {
      return res.status(400).json({ error: err.message });
    }

    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: "Aucun fichier reçu" });
    }

    const uploadedFiles = req.files.map((file) => ({
      filename: file.filename,
      publicPath: `${roomId}/${file.filename}`,
    }));

    return res.status(200).json({
      success: true,
      files: uploadedFiles,
    });
  });
});

// Endpoint pour fusionner vidéo et audio
app.post("/merge-video-audio", async (req, res) => {
  try {
    const { videoPath, audioPath, roomId, playerName } = req.body;

    // Chemins des fichiers
    const videoFullPath = path.join(__dirname, "public", roomId, videoPath);
    const audioFullPath = path.join(__dirname, "uploads", audioPath);

    // Vérifier que les fichiers existent
    if (!fs.existsSync(videoFullPath)) {
      return res
        .status(404)
        .json({ success: false, error: "Fichier vidéo non trouvé" });
    }

    if (!fs.existsSync(audioFullPath)) {
      return res
        .status(404)
        .json({ success: false, error: "Fichier audio non trouvé" });
    }

    // Nom du fichier de sortie
    const outputFilename = `merged_${playerName}_${Date.now()}.mp4`;
    const outputPath = path.join(
      __dirname,
      "uploads",
      "merged",
      outputFilename
    );

    // Créer le dossier merged s'il n'existe pas
    const mergedDir = path.join(__dirname, "uploads", "merged");
    if (!fs.existsSync(mergedDir)) {
      fs.mkdirSync(mergedDir, { recursive: true });
    }

    // Utiliser FFmpeg pour fusionner
    ffmpeg()
      .input(videoFullPath)
      .input(audioFullPath)
      .outputOptions([
        "-c:v copy", // Copier le codec vidéo sans réencoder
        "-c:a aac", // Encoder l'audio en AAC
        "-map 0:v:0", // Prendre la vidéo du premier input
        "-map 1:a:0", // Prendre l'audio du deuxième input
        "-shortest", // Arrêter quand le plus court des deux se termine
      ])
      .output(outputPath)
      .on("end", () => {
        console.log("✅ Fusion terminée:", outputFilename);
        res.json({
          success: true,
          filename: outputFilename,
          message: "Fichiers fusionnés avec succès",
        });
      })
      .on("error", (err) => {
        console.error("❌ Erreur FFmpeg:", err);
        res.status(500).json({
          success: false,
          error: "Erreur lors de la fusion: " + err.message,
        });
      })
      .run();
  } catch (error) {
    console.error("❌ Erreur serveur:", error);
    res.status(500).json({
      success: false,
      error: "Erreur serveur: " + error.message,
    });
  }
});

// Endpoint pour télécharger les fichiers fusionnés
app.get("/download-merged/:filename", (req, res) => {
  const filename = req.params.filename;
  const filePath = path.join(__dirname, "uploads", "merged", filename);

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: "Fichier non trouvé" });
  }

  res.download(filePath, (err) => {
    if (err) {
      console.error("❌ Erreur téléchargement:", err);
      return res.status(500).json({ error: "Erreur lors du téléchargement" });
    }

    // Optionnel: supprimer le fichier après téléchargement
    setTimeout(() => {
      fs.unlink(filePath, (unlinkErr) => {
        if (unlinkErr) {
          console.error("❌ Erreur suppression fichier fusionné:", unlinkErr);
        } else {
          console.log("🗑️ Fichier fusionné supprimé:", filename);
        }
      });
    }, 5000); // Attendre 5 secondes avant de supprimer
  });
});

app.post("/upload", upload.single("audio"), (req, res) => {
  res.send({ filename: req.file.filename });
});

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
