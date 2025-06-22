import { WebSocketServer } from 'ws';
import { RealtimeClient } from '@openai/realtime-api-beta';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import path from 'path';
import dotenv from 'dotenv';
import express from 'express';
import http from 'http';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);



class RealtimeRelay {
    constructor() {
        this.apiKey = process.env.OPENAI_API_KEY;
        if (!this.apiKey) {
            throw new Error('OPENAI_API_KEY environment variable is required');
        }
    }

    log(message) {
        console.log(`[${new Date().toISOString()}] ${message}`);
    }

    async handleConnection(ws, req) {
        if (!req.url) {
            this.log('No URL provided, closing connection.');
            ws.close();
            return;
        }

        // Instantiate new client
        this.log(`Connecting with key "${this.apiKey.slice(0, 3)}..."`);
        const client = new RealtimeClient({ apiKey: this.apiKey });
        // Relay: OpenAI Realtime API Event -> Browser Event
        client.realtime.on('server.*', (event) => {
            this.log(`Relaying "${event.type}" to Client`);
            if (event.delta?.audio || event.done?.audio) {
                ws.send(event);  // Send raw data for audio
            } else {
                ws.send(JSON.stringify(event));
            }
        });
        client.realtime.on('close', () => ws.close());

        // Relay: Browser Event -> OpenAI Realtime API Event
        const messageQueue = [];
        const messageHandler = (data) => {
            try {
                const event = JSON.parse(data);
                this.log(`Relaying "${event.type}" to OpenAI`);
                client.realtime.send(event.type, event);
            } catch (e) {
                console.error(e.message);
                this.log(`Error parsing event from client: ${data}`);
            }
        };

        ws.on('message', (data) => {
            if (!client.isConnected()) {
                messageQueue.push(data);
            } else {
                messageHandler(data);
            }
        });
        ws.on('close', () => client.disconnect());

        // Connect to OpenAI Realtime API
        try {
            this.log(`Connecting to OpenAI...`);
            await client.connect();
        } catch (e) {
            this.log(`Error connecting to OpenAI: ${e.message}`);
            ws.close();
            return;
        }
        this.log(`Connected to OpenAI successfully!`);
        
        // Process queued messages
        while (messageQueue.length) {
            messageHandler(messageQueue.shift());
        }
    }
}

// Setup Express and WebSocket server
const app = express();
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });


app.use(express.static(path.join(__dirname, 'public')));
app.use('/lib/wavtools', express.static(path.join(__dirname, 'src/lib/wavtools')));

app.use('/styles.css', (req, res) => {
    res.setHeader('Content-Type', 'text/css');
    res.sendFile(path.join(__dirname, 'public', 'styles.css'));
});
// Serve the main HTML file at root
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'realtime.html'));
});

// Agora config route
app.get('/config/agora', (req, res) => {
    console.log('Agora config requested');
    if (!process.env.AGORA_APP_ID) {
        console.error('Agora configuration missing');
        return res.status(500).json({ error: 'Agora configuration not found' });
    }
    
    res.json({
        appId: process.env.AGORA_APP_ID,
        channel: process.env.AGORA_CHANNEL,
        token: process.env.AGORA_TOKEN,
        uid: parseInt(process.env.AGORA_UID)
    });
});

// Log all routes for debugging
app.use((req, res, next) => {
    console.log(`[Server] ${req.method} ${req.url}`);
    next();
});


const relay = new RealtimeRelay();
wss.on('connection', (ws, req) => {
    relay.handleConnection(ws, req);
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});