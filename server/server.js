const express = require("express");
const http = require("http");
const socketIo = require("socket.io");
const multer = require("multer");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
require("dotenv").config();

const app = express();
app.use(cors({
  origin: process.env.FRONTEND_ORIGIN || "*",
  methods: ["GET", "POST"],
  credentials: true,
}));
app.use("/uploads", express.static(path.join(__dirname, "uploads")));
app.use(express.static("public"));

const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: process.env.FRONTEND_ORIGIN || "*",
    methods: ["GET", "POST"],
    credentials: true,
  },
});

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, "uploads/"),
  filename: (req, file, cb) =>
    cb(null, Date.now() + "-" + Math.round(Math.random() * 1e9) + ".webm"),
});

const upload = multer({ storage });

const clips = ["clip1.mp4", "clip2.mp4"]; // à adapter à ton contenu

let rooms = {}; // roomId: { players, recordings, hostId, validated, clipIndex }

function playNextClip(roomId) {
  const room = rooms[roomId];
  if (!room) return;

  if (!room.clipIndex) {
    room.clipIndex = 0;

    // 🔁 Initialiser les scores à 0 dès le début
    room.scores = {};
    for (const playerId of room.players.keys()) {
      room.scores[playerId] = 0;
    }

    // 🔼 Envoyer les scores initiaux
    const scoresByName = {};
    for (const [socketId, score] of Object.entries(room.scores)) {
      const name = room.players.get(socketId);
      if (name) scoresByName[name] = score;
    }
    io.to(roomId).emit("update_scores", scoresByName);
  }

  if (room.clipIndex >= clips.length) {
    io.to(roomId).emit("game_over");
    return;
  }

  const clipName = clips[room.clipIndex];

  // Déterminer la phase spéciale avant lancement officiel
  const phase = room.clipIndex === 0 ? "waiting_start" : "playing_clip";
  io.to(roomId).emit("phase_change", phase);
  io.to(roomId).emit("play_clip", { clipName });
  io.to(roomId).emit("phase_change", "playing_clip");

  // Reset state
  room.recordings = {};
  room.validated = new Set();

  room.clipIndex++;
}

io.on("connection", (socket) => {
  socket.on("join", ({ roomId, name }) => {
    socket.join(roomId);
    if (!rooms[roomId]) {
      rooms[roomId] = {
        players: new Map(),
        recordings: {},
        validated: new Set(),
        hostId: socket.id,
        clipIndex: 0,
        scores: {},
        clips: ["clip1.mp4", "clip2.mp4"],
      };
    }

    const room = rooms[roomId];
    room.players.set(socket.id, name);

    if (!room.hostId) room.hostId = socket.id;

    io.to(roomId).emit("update_players", {
      names: Object.fromEntries(room.players),
      hostId: room.hostId,
    });

    if (room.players.size === 2) {
      io.to(roomId).emit("phase_change", "waiting_start");
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
    // Refus si ce joueur a déjà voté pour cette cible
    if (room.votes[targetId].some((v) => v.voter === socket.id)) return;
    room.votes[targetId].push({ voter: socket.id, note });
    const expectedVotes = room.players.size - 1;

    if (room.votes[targetId].length === expectedVotes) {
      const total = room.votes[targetId].reduce((sum, v) => sum + v.note, 0);
      room.scores[targetId] = (room.scores[targetId] || 0) + total;

      // Émettre les scores
      const scoresByName = {};
      for (const [socketId, score] of Object.entries(room.scores)) {
        const name = room.players.get(socketId);
        if (name) scoresByName[name] = score;
      }
      io.to(roomId).emit("update_scores", scoresByName);

      // Passer au prochain vote
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

    // Supprimer les anciens fichiers d'enregistrements
    for (const blobName of Object.values(room.recordings)) {
      const filePath = path.join(__dirname, "uploads", blobName);
      fs.unlink(filePath, (err) => {
        if (err) console.error("❌ Erreur suppression fichier:", filePath, err);
        else console.log("🗑️ Fichier supprimé:", filePath);
      });
    }

    // Réinitialiser l'état de la room
    room.recordings = {};
    room.validated = new Set();
    room.voteQueue = [];
    room.currentVoteIndex = 0;
    room.votes = {};

    if (room.clipIndex >= room.clips.length) {
      // ✅ Fin de partie : vider dossier uploads
      const uploadsDir = path.join(__dirname, "uploads");
      fs.readdir(uploadsDir, (err, files) => {
        if (err) return console.error("Erreur lecture uploads:", err);
        for (const file of files) {
          fs.unlink(path.join(uploadsDir, file), (err) => {
            if (err) console.error("Erreur suppression fichier:", file, err);
          });
        }
      });

      // ✅ Envoyer game over
      io.to(roomId).emit("game_over");
      return; // ← ⚠️ NÉCESSAIRE : ne pas appeler playNextClip après
    }

    // Lancer le prochain clip
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

app.post("/upload", upload.single("audio"), (req, res) => {
  res.send({ filename: req.file.filename });
});

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
