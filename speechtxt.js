require('dotenv').config();
const express = require('express');
const multer = require('multer');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const wav = require('node-wav');
const wavEncoder = require('wav-encoder');
const speech = require('@google-cloud/speech');
const ffmpeg = require('ffmpeg-static');
const { Storage } = require('@google-cloud/storage');
const { Sequelize, DataTypes } = require('sequelize');

// Inisialisasi Express
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Google Cloud Configuration
process.env.GOOGLE_APPLICATION_CREDENTIALS = 'speech-to-text.json';

// Inisialisasi Google Cloud Storage
const storage = new Storage({ keyFilename: path.join(__dirname, 'speech-to-text.json') });
const bucket = storage.bucket(process.env.GCP_BUCKET_NAME);

// Database Configuration
const sequelize = new Sequelize(
  process.env.DB_NAME,    
  process.env.DB_USER,    
  process.env.DB_PASSWORD, 
  {
    host: process.env.DB_HOST,
    dialect: 'mysql',
    logging: false,
  }
);

// Model Speechtotext
const Speechtotext = sequelize.define('Speechtotext', {
  id: {
    type: DataTypes.STRING,
    primaryKey: true,  
    autoIncrement: true,  
  },
  audioUrl: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  text: {
    type: DataTypes.TEXT,
    allowNull: false,
  },
  fileName: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  createdByEmail: {
    type: DataTypes.STRING,
    allowNull: false,
  },
}, {
  timestamps: true,  
});

// Sinkronisasi model dengan database
Speechtotext.sync()
  .then(() => console.log('Speechtotext model synced with database.'))
  .catch((error) => console.error('Error syncing speechtotext model:', error));

// Konfigurasi Multer untuk upload file audio
const upload = multer({
  dest: 'uploads/', 
  fileFilter: (req, file, cb) => {
    const allowedMimes = [
      'audio/wav', 
      'audio/ogg', 
      'audio/mp3', 
      'audio/x-wav', 
      'audio/x-pn-wav', 
      'audio/wave' // Tambahkan MIME type 'audio/wave'
    ]; 
    console.log('MIME type file:', file.mimetype); // Log MIME type untuk debugging
    if (allowedMimes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Format file tidak didukung. Hanya WAV, OGG, MP3 diperbolehkan.'));
    }
  },
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB
  },
});


// Fungsi konversi audio ke WAV
async function convertAudioToWav(inputFile, tempWavFile) {
  try {
    execSync(`${ffmpeg} -i ${inputFile} -acodec pcm_s16le -ar 16000 ${tempWavFile}`, { stdio: 'ignore' });
    return tempWavFile;
  } catch (error) {
    throw new Error('Error saat konversi audio ke WAV.');
  }
}

// Fungsi konversi ke mono
async function convertToMono(inputFile, outputFile) {
  const buffer = fs.readFileSync(inputFile);
  const decoded = wav.decode(buffer);

  if (decoded.channelData.length === 1) {
    fs.writeFileSync(outputFile, buffer);
    return decoded.sampleRate;
  }

  const monoChannel = decoded.channelData[0].map((_, i) =>
    (decoded.channelData[0][i] + decoded.channelData[1][i]) / 2
  );

  const encoded = await wavEncoder.encode({
    sampleRate: decoded.sampleRate,
    channelData: [monoChannel],
  });

  fs.writeFileSync(outputFile, Buffer.from(encoded));
  return decoded.sampleRate;
}

// Fungsi transkripsi audio
async function transcribeAudio(audiofile, sampleRate) {
  const client = new speech.SpeechClient();
  const file = fs.readFileSync(audiofile);
  const audioBytes = file.toString('base64');

  const request = {
    audio: { content: audioBytes },
    config: {
      encoding: 'LINEAR16',
      sampleRateHertz: sampleRate,
      languageCode: 'id-ID',
    },
  };

  const [response] = await client.recognize(request);
  return response.results.map(r => r.alternatives[0].transcript).join('\n');
}

// Fungsi untuk menyimpan transkripsi ke Google Cloud Storage
async function saveTranscriptionToCloud(transcription, filename) {
  const file = bucket.file(`transcriptions/${filename}.txt`);
  await file.save(transcription, {
    contentType: 'text/plain',
    metadata: {
      cacheControl: 'public, max-age=31536000',
    },
  });
  return `https://storage.googleapis.com/${process.env.GCP_BUCKET_NAME}/transcriptions/${filename}.txt`;
}

// Endpoint POST untuk Upload dan Transkripsi Audio
app.post("/speechtotext", upload.single('audio'), async (req, res) => {
  try {
    const { email, title } = req.body;  

    if (!email || !title || !req.file) {
      return res.status(400).json({ error: "Email, title, and audio file are required" });
    }

    const file = req.file;  
    const tempWavFile = path.join('uploads', `${path.parse(file.filename).name}_temp.wav`);
    const monoFile = path.join('uploads', `${path.parse(file.filename).name}_mono.wav`);

    await convertAudioToWav(file.path, tempWavFile);

    const sampleRate = await convertToMono(tempWavFile, monoFile);

    const transcription = await transcribeAudio(monoFile, sampleRate);

    const transcriptionUrl = await saveTranscriptionToCloud(transcription, file.filename);

    const transcriptionData = await Speechtotext.create({
      audioUrl: transcriptionUrl, 
      text: transcription,        
      fileName: file.filename,    
      createdByEmail: email,      
    });

    res.status(201).json({
      success: true,
      message: "Transcription created successfully",
      data: transcriptionData,  
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      success: false,
      error: "Failed to create transcription",
    });
  } 
});

// Endpoint GET untuk mendapatkan transkripsi berdasarkan email dalam URL path
app.get("/speechtotext/:email", async (req, res) => {
  const { email } = req.params;  

  if (!email) {
    return res.status(400).json({ error: "Email parameter is required" });
  }

  try {
    const transcriptions = await Speechtotext.findAll({
      where: { createdByEmail: email },
    });

    if (transcriptions.length === 0) {
      return res.status(404).json({ message: "No transcriptions found for this email" });
    }

    res.status(200).json({
      success: true,
      data: transcriptions,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      success: false,
      error: "Failed to fetch transcriptions",
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server berjalan di port ${PORT}`);
  console.log(`Test API at: http://localhost:${PORT}`);
  console.log("\nAvailable routes:");
  console.log("- POST   /speechtotext    : Upload dan transkripsi file audio");
  console.log("- GET    /speechtotext    : Get transcriptions by email");
});
