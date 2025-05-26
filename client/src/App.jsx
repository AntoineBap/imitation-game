import { useEffect, useRef, useState } from "react";
import { io } from "socket.io-client";
import "./App.scss";

const backendURL = import.meta.env.VITE_BACKEND_URL;

const socket = io(backendURL);

export default function App() {
  const [phase, setPhase] = useState("lobby_selection");
  const [name, setName] = useState("");
  const [players, setPlayers] = useState({});
  const [hostId, setHostId] = useState(null);
  const [recordings, setRecordings] = useState({});
  const [showVideo, setShowVideo] = useState(false);
  const [socketId, setSocketId] = useState(null);
  const [isRecording, setIsRecording] = useState(false);
  const [hasRecorded, setHasRecorded] = useState(false);
  const [audioURL, setAudioURL] = useState(null);
  const [audioBlob, setAudioBlob] = useState(null);
  const [mediaRecorder, setMediaRecorder] = useState(null);
  const [validatedCount, setValidatedCount] = useState(0);
  const [playerCount, setPlayerCount] = useState(0);
  const [currentVoterId, setCurrentVoterId] = useState(null);
  const [currentAudio, setCurrentAudio] = useState(null);
  const [currentClip, setCurrentClip] = useState("sailor_moon.mp4");
  const [scores, setScores] = useState({});
  const [hasVoted, setHasVoted] = useState(false);
  const [videoEnded, setVideoEnded] = useState(false);
  const [isLocallyRecording, setIsLocallyRecording] = useState(false);
  const [countdown, setCountdown] = useState(null);
  const [hasValidated, setHasValidated] = useState(false);
  const [buttonCountdown, setButtonCountdown] = useState(null);
  const [buttonAction, setButtonAction] = useState(null);
  const [videoDuration, setVideoDuration] = useState(null);
  const [recordingProgress, setRecordingProgress] = useState(0);
  const [roomId, setRoomId] = useState(null); // room dynamique
  const [joinCode, setJoinCode] = useState(""); // input utilisateur

  const videoRef = useRef(null);
  const audioRef = useRef(null);
  const chunksRef = useRef([]);
  const isHost = socketId === hostId;

  const handleVote = (note) => {
    if (hasVoted) return;
    socket.emit("vote", { roomId, targetId: currentVoterId, note });
    setHasVoted(true);
  };

  useEffect(() => {
    const handleConnect = () => setSocketId(socket.id);
    const handleStartGame = () => setPhase("playing_clip");
    const handlePlayClip = ({ clipName }) => {
      setCurrentClip(clipName);
      setPhase("playing_clip");
      setShowVideo(true);
      setAudioBlob(null);
      setAudioURL(null);
      setHasRecorded(false);
      setIsRecording(false);
      setVideoEnded(false);
      setValidatedCount(0);
      setHasValidated(false);
    };
    const handleStartRecording = () => {
      setPhase("recording");
      setShowVideo(true);
    };
    const handleUpdatePlayers = ({ names, hostId }) => {
      setPlayers(names);
      setHostId(hostId);
      setPlayerCount(Object.keys(names).length);
    };
    const handleUpdateValidations = ({ count }) => setValidatedCount(count);
    const handlePlayRecordings = (recs) => {
      setRecordings(recs);
      setPhase("playing_recordings");
    };
    const handleStartCountdown = ({ seconds }) => {
      setCountdown(seconds); // init du countdown
    };
    const handleStartVotePhase = ({ voterId, filename }) => {
      setCurrentVoterId(voterId);
      setCurrentAudio(filename);
      setHasVoted(false);
      setPhase("voting");
    };
    const handleGameOver = () => {
      setPhase("final_scoreboard");
    };
    const handleVotingDone = (votes) => {
      console.log("Votes terminés:", votes);
      setPhase("voting_done");
    };
    const handleUpdateScores = (newScores) => setScores(newScores);
    const handlePhaseChange = (newPhase) => setPhase(newPhase);

    // Listen
    socket.on("connect", handleConnect);
    socket.on("start_game", handleStartGame);
    socket.on("play_clip", handlePlayClip);
    socket.on("start_recording", handleStartRecording);
    socket.on("update_players", handleUpdatePlayers);
    socket.on("update_validations", handleUpdateValidations);
    socket.on("play_recordings", handlePlayRecordings);
    socket.on("start_countdown", handleStartCountdown);
    socket.on("start_vote_phase", handleStartVotePhase);
    socket.on("game_over", handleGameOver);
    socket.on("voting_done", handleVotingDone);
    socket.on("update_scores", handleUpdateScores);
    socket.on("phase_change", handlePhaseChange);

    return () => {
      socket.off("connect", handleConnect);
      socket.off("start_game", handleStartGame);
      socket.off("play_clip", handlePlayClip);
      socket.off("start_recording", handleStartRecording);
      socket.off("update_players", handleUpdatePlayers);
      socket.off("update_validations", handleUpdateValidations);
      socket.off("play_recordings", handlePlayRecordings);
      socket.off("start_countdown", handleStartCountdown);
      socket.off("start_vote_phase", handleStartVotePhase);
      socket.off("game_over", handleGameOver);
      socket.off("voting_done", handleVotingDone);
      socket.off("update_scores", handleUpdateScores);
      socket.off("phase_change", handlePhaseChange);
    };
  }, []);

  useEffect(() => {
    if (countdown === null || countdown <= 0) return;

    const interval = setInterval(() => {
      setCountdown((prev) => {
        if (prev <= 1) {
          clearInterval(interval);
          return null;
        }
        return prev - 1;
      });
    }, 1000);

    return () => clearInterval(interval);
  }, [countdown]);

  useEffect(() => {
    socket.on("start_button_countdown", ({ action }) => {
      setButtonCountdown(3);
      setButtonAction(action);
    });

    return () => {
      socket.off("start_button_countdown");
    };
  }, []);

  useEffect(() => {
    if (buttonCountdown === null) return;

    if (buttonCountdown === 0) {
      if (isHost && buttonAction) {
        if (buttonAction === "start_game") {
          socket.emit("host_start_clip", roomId);
        } else if (buttonAction === "listen_imitations") {
          socket.emit("host_start_votes", roomId);
        } else if (buttonAction === "next_clip") {
          socket.emit("host_next_clip", roomId);
        }
      }

      setButtonCountdown(null);
      setButtonAction(null);
      return;
    }

    const timer = setTimeout(() => {
      setButtonCountdown(buttonCountdown - 1);
    }, 1000);

    return () => clearTimeout(timer);
  }, [buttonCountdown, buttonAction, isHost]);

  useEffect(() => {
    if (phase === "voting" && videoRef.current) {
      const video = videoRef.current;

      // Remet la vidéo au début
      video.currentTime = 0;
      video.muted = true;

      const playVideo = () => {
        // Essaye de lancer la vidéo
        const playPromise = video.play();

        // Certaines versions de navigateur nécessitent une gestion des promesses
        if (playPromise !== undefined) {
          playPromise.catch((error) => {
            console.warn("Erreur de lecture vidéo :", error);
          });
        }
      };

      // Attends un tout petit délai pour être sûr que le DOM est à jour
      setTimeout(() => {
        playVideo();
      }, 100);
    }
  }, [currentAudio, phase]);

  useEffect(() => {
    if (videoDuration && isRecording) {
      const timer = setTimeout(() => {
        stopRecording();
      }, videoDuration * 1000);

      return () => clearTimeout(timer);
    }
  }, [videoDuration, isRecording]);

  useEffect(() => {
    if (!isRecording || !videoDuration) return;

    const startTime = Date.now();

    const interval = setInterval(() => {
      const elapsed = (Date.now() - startTime) / 1000;
      const progress = Math.min((elapsed / videoDuration) * 100, 100);
      setRecordingProgress(progress);
    }, 100); // mise à jour toutes les 100ms

    return () => clearInterval(interval);
  }, [isRecording, videoDuration]);

  const startClip = () => {
    setShowVideo(true);
    socket.emit("phase_change", "playing_clip");
  };

  const startRecording = async () => {
    setIsLocallyRecording(true);
    setPhase("recording");
    setShowVideo(true);

    if (videoRef.current) {
      videoRef.current.currentTime = 0;
      videoRef.current.muted = true;
      videoRef.current.play();
    }

    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const recorder = new MediaRecorder(stream);
    chunksRef.current = [];

    recorder.ondataavailable = (e) => chunksRef.current.push(e.data);

    setMediaRecorder(recorder);
    recorder.start();
    setIsRecording(true);
  };

  const stopRecording = () => {
    return new Promise((resolve) => {
      if (!mediaRecorder) return resolve();

      mediaRecorder.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: "audio/webm" });
        const url = URL.createObjectURL(blob);
        setAudioBlob(blob);
        setAudioURL(url);
        setHasRecorded(true);
        setIsRecording(false);
        setTimeout(() => {
          if (videoRef.current && audioRef.current) {
            videoRef.current.currentTime = 0;
            audioRef.current.currentTime = 0;
            videoRef.current.muted = true;

            videoRef.current.play().catch((err) => {
              console.error("Erreur lecture vidéo:", err);
            });

            audioRef.current.play().catch((err) => {
              console.error("Erreur lecture audio:", err);
            });
          }
        }, 300);

        resolve();
      };

      mediaRecorder.stop();
      setIsLocallyRecording(false);
    });
  };

  const cancelRecording = () => {
    mediaRecorder?.stop();
    setIsLocallyRecording(false);
    setIsRecording(false);
    setAudioBlob(null);
    setAudioURL(null);
    setHasRecorded(false);
  };

  const discardRecording = () => {
    if (videoRef.current) {
      videoRef.current.pause();
      videoRef.current.currentTime = 0;
    }
    setAudioBlob(null);
    setAudioURL(null);
    setHasRecorded(false);
  };

  const validateRecording = async () => {
    setHasValidated(true);
    const formData = new FormData();
    formData.append("audio", audioBlob);

    const res = await fetch(`${backendURL}/upload`, {
      method: "POST",
      body: formData,
    });

    const data = await res.json();
    setIsLocallyRecording(false);
    socket.emit("recording_done", { roomId, blobName: data.filename });
  };

  return (
    <div className="game_container">
      <h1 className="game_title">Imitation Game</h1>

      {phase === "lobby_selection" && (
        <div className="lobby_selection">
          <h2>Bienvenue !</h2>
          <button
            className="create_room_btn"
            onClick={() => setPhase("create_room")}
          >
            Créer un salon
          </button>
          <button
            className="join_room_btn"
            onClick={() => setPhase("join_room")}
          >
            Rejoindre un salon
          </button>
        </div>
      )}

      {phase === "create_room" && (
        <div className="create_room">
          <div className="top_content">
            <button
              className="back_arrow_btn"
              onClick={() => {
                setPhase("lobby_selection");
              }}
            >
              <img src="./back_arrow.svg" alt="" />
            </button>
            <h2>Créer un salon</h2>
          </div>

          <div className="name_input_container">
            <input
              placeholder="Ton prénom"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <button
              onClick={() => {
                if (!name.trim()) return;
                socket.emit("create_room", { name }, ({ success, roomId }) => {
                  if (success) {
                    setRoomId(roomId);
                    setPhase("waiting");
                  } else {
                    alert("Erreur création salon");
                  }
                });
              }}
            >
              Créer
            </button>
          </div>
        </div>
      )}

      {phase === "join_room" && (
        <div className="join_room">
          <div className="top_content">
            <button
              className="back_arrow_btn"
              onClick={() => {
                setPhase("lobby_selection");
              }}
            >
              <img src="./back_arrow.svg" alt="" />
            </button>
            <h2>Rejoindre un salon</h2>
          </div>
          <div className="name_input_container">
            <input
              placeholder="Code à 6 chiffres"
              value={joinCode}
              maxLength={6}
              onChange={(e) => setJoinCode(e.target.value.replace(/\D/g, ""))}
            />
            <input
              placeholder="Ton prénom"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <button
              onClick={() => {
                if (!name.trim() || joinCode.length !== 6) return;
                socket.emit(
                  "join_room",
                  { code: joinCode, name },
                  ({ success, roomId, error }) => {
                    if (success) {
                      setRoomId(roomId);
                      setPhase("waiting");
                    } else {
                      alert("Salon introuvable");
                    }
                  }
                );
              }}
            >
              Rejoindre
            </button>
          </div>
        </div>
      )}

      {phase === "waiting_start" && !isHost && (
        <p className="waiting">
          🕒 En attente du host pour lancer la partie...
        </p>
      )}

      {phase === "waiting_start" && isHost && (
        <button
          className="waiting_start"
          onClick={() => {
            socket.emit("request_button_countdown", {
              roomId,
              action: "start_game",
            });
          }}
        >
          Commencer la partie
        </button>
      )}

      {phase === "playing_clip" && currentClip && (
        <div className="playing_clip">
          <video
            key={currentClip}
            ref={videoRef}
            src={`/${currentClip}`}
            controls
            autoPlay
            onEnded={() => {
              socket.emit("clip_done", roomId);
              setVideoEnded(true);
            }}
          />
          {videoEnded && (
            <button className="record_button" onClick={startRecording}>
              <img src="micro.svg" alt="" />
            </button>
          )}
        </div>
      )}

      {phase === "recording" && showVideo && (
        <div className="recording">
          {!isLocallyRecording && (
            <video ref={videoRef} src={`/${currentClip}`} controls />
          )}

          {isLocallyRecording && (
            <video
              ref={videoRef}
              src={`/${currentClip}`}
              autoPlay
              controls
              muted
              onLoadedMetadata={() => {
                if (videoRef.current) {
                  setVideoDuration(videoRef.current.duration);
                }
              }}
            />
          )}

          {!isRecording && !hasRecorded && (
            <button className="record_button" onClick={startRecording}>
              <img src="./micro.svg" alt="" />
            </button>
          )}

          {isRecording && (
            <div className="recording_container">
              <div className="progress_bar_container">
                <div className="progress_bar_bg">
                  <div
                    className="progress_bar"
                    style={{ width: `${recordingProgress}%` }}
                  />
                </div>
              </div>

              <div className="buttons_container">
                <p>⏺️ Enregistrement en cours...</p>
                <button className="cancel_button" onClick={cancelRecording}>
                  <img src="./bin.svg" alt="bin icon" />
                </button>
                <button className="end_record_btn" onClick={stopRecording}>
                  <img src="./check.svg" alt="check icon" />
                </button>
              </div>
            </div>
          )}

          {hasRecorded && audioURL && (
            <div className="recorded_audio">
              <audio ref={audioRef} controls src={audioURL}></audio>
              <div className="buttons_container">
                <button
                  className="discard_btn"
                  onClick={discardRecording}
                  disabled={hasValidated}
                >
                  🗑️ Supprimer
                </button>
                <button
                  className="validate_btn"
                  onClick={validateRecording}
                  disabled={hasValidated}
                >
                  ✅ Valider
                </button>
              </div>
            </div>
          )}

          {hasRecorded && (
            <p>
              ✅ Joueurs ayant validé : {validatedCount} / {playerCount}
            </p>
          )}
        </div>
      )}

      {phase === "playing_recordings" && isHost && (
        <button
          className="listen_btn"
          onClick={() => {
            socket.emit("request_button_countdown", {
              roomId,
              action: "listen_imitations",
            });
          }}
        >
          🔊 Écouter les imitations
        </button>
      )}

      {phase === "playing_recordings" && !isHost && (
        <h2>🕒 En attente du host pour écouter les imitations...</h2>
      )}

      {phase === "voting" && (
        <div className="voting">
          <p>
            🎧 Écoute de l’imitation de{" "}
            <strong>{players[currentVoterId] || "Inconnu"}</strong>
          </p>
          <video
            ref={videoRef}
            src={`/${currentClip}`}
            autoPlay
            muted
            controls
          />
          <audio
            src={`${backendURL}/uploads/${currentAudio}`}
            controls
            autoPlay
          />
          {socketId !== currentVoterId ? (
            <div className="rating_container">
              <p>Attribuez une note :</p>
              {[-1, 1, 2].map((note) => (
                <button
                  data-id={note}
                  key={note}
                  onClick={() => handleVote(note)}
                  disabled={hasVoted}
                >
                  {note}
                </button>
              ))}
            </div>
          ) : (
            <p>🛑 Tu ne peux pas voter pour toi-même</p>
          )}
        </div>
      )}

      {phase === "voting_done" && (
        <div className="voting_done">
          <h2>🎉 Fin du tour !</h2>
          {isHost && (
            <button
              onClick={() => {
                socket.emit("request_button_countdown", {
                  roomId,
                  action: "next_clip",
                });
              }}
            >
              🔁 Lancer le prochain clip
            </button>
          )}
          {!isHost && (
            <h2>🕒 En attente du host pour lancer le prochain clip...</h2>
          )}
        </div>
      )}

      {countdown !== null && (
        <div className="countdown-message">
          Tout le monde à voté ! Prochain audio dans {countdown} seconde
          {countdown > 1 ? "s" : ""}
        </div>
      )}

      {buttonCountdown !== null && (
        <div className="global-countdown">
          ⏳ Démarrage dans {buttonCountdown} seconde
          {buttonCountdown > 1 ? "s" : ""}
        </div>
      )}

      {(phase === "waiting" || phase === "waiting_start") && (
        <div className="players_connected">
          <h2>👥 Joueurs connectés : </h2>
          <p>
            🔐 Code du salon : <strong>{roomId}</strong>
          </p>
          <ol>
            {Object.entries(players).map(([id, name]) => (
              <li key={id}>
                {name}
                {id === hostId && " (Hôte)"}
              </li>
            ))}
          </ol>
        </div>
      )}

      {![
        "lobby_selection",
        "create_room",
        "join_room",
        "waiting",
        "waiting_start",
        "final_scoreboard",
      ].includes(phase) && (
        <div className="scoreboard">
          <h2>🏆 Scores </h2>
          {Object.entries(scores).map(([name, score]) => (
            <div className="player">
              <div>{name}</div>
              <div>{score}</div>
            </div>
          ))}
        </div>
      )}

      {phase === "final_scoreboard" && (
        <div className="final_scoreboard">
          <h2>🏆 Résultats finaux 🏆</h2>
          {Object.entries(scores)
            .sort((a, b) => b[1] - a[1])
            .map(([name, score], index) => (
              <div className="player" key={name}>
                <div>
                  {index + 1}. {name}
                </div>
                <div>{score} pts</div>
              </div>
            ))}
        </div>
      )}
    </div>
  );
}
