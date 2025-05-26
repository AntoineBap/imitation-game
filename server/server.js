const express = require("express");
const http = require("http");
const socketIo = require("socket.io");
const multer = require("multer");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
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
  destination: (req, file, cb) => cb(null, "uploads/"),
  filename: (req, file, cb) =>
    cb(null, Date.now() + "-" + Math.round(Math.random() * 1e9) + ".webm"), // determine le nom du fichier audio
});

const upload = multer({ storage });

const clips = [
  "asterion_morose.mp4",
  "asterion_vache.mp4",
  "bassem_aller_ftg.mp4",
  "mario_chute.mp4",
  "scooby_doo.mp4",
  "seranno.mp4",
  "skype.mp4",
  "zombie.mp4",
  "gnegnegne.mp4",
  "guettez_barre.mp4",
  "amr_khera.mp4",
  "jean_cacabox.mp4",
  "gamixtreize_bz.mp4",
  "clash_r_emotes.mp4",
  "broly.mp4",
]; // nouveau clip modif ici

let rooms = {}; // roomId: { players, recordings, hostId, validated, clipIndex }

function playNextClip(roomId) {
  const room = rooms[roomId];
  if (!room) return;

  if (!room.clipIndex) {
    room.clipIndex = 0;

    // Initialise les scores a 0 des le debut
    room.scores = {};
    for (const playerId of room.players.keys()) {
      room.scores[playerId] = 0;
    }

    // envoie les scores initiaux
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

  // determine la phase dans le lobby avant lancement de la partie
  const phase = room.clipIndex === 0 ? "waiting_start" : "playing_clip";
  io.to(roomId).emit("phase_change", phase);
  io.to(roomId).emit("play_clip", { clipName });
  io.to(roomId).emit("phase_change", "playing_clip");

  // eeset state
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
      clips: clips,
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
      // vide le dossier uploads en fin de game
      const uploadsDir = path.join(__dirname, "uploads");
      fs.readdir(uploadsDir, (err, files) => {
        if (err) return console.error("Erreur lecture uploads:", err);
        for (const file of files) {
          fs.unlink(path.join(uploadsDir, file), (err) => {
            if (err) console.error("Erreur suppression fichier:", file, err);
          });
        }
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

app.post("/upload", upload.single("audio"), (req, res) => {
  res.send({ filename: req.file.filename });
});

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
