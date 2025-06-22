import { WavRecorder, WavStreamPlayer } from '../lib/wavtools/index.js';

// --- Global State ---
let ws = null;
let recorder = null;
let player = null;
let isManualMode = true;
let isRecording = false;
let isConnected = false;
let sourceLanguage = 'English';
let targetLanguage = 'Hindi';
let audioWaveform;
let agoraOptions = null;
let rtc = {
    client: null,
    localAudioTrack: null,
    localVideoTrack: null,
    remoteUsers: {},
    audioContext: null,
    streamDestination: null,
    customAudioTrack: null,
    isInCall: false,
};
let isVideoEnabled = true;
let isTranslationEnabled = false;
let wordElements = [];
let currentWordIndex = 0;
let highlightInterval = null;
let audioQueue = [];
let isPlaying = false;

// --- Translated Audio Routing ---
async function setupTranslatedAudioRouting() {
    if (!rtc.audioContext) {
        rtc.audioContext = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (!rtc.streamDestination) {
        rtc.streamDestination = rtc.audioContext.createMediaStreamDestination();
    }
    if (!rtc.customAudioTrack) {
        rtc.customAudioTrack = AgoraRTC.createCustomAudioTrack({
            mediaStreamTrack: rtc.streamDestination.stream.getAudioTracks()[0]
        });
    }
}

function resetAudioQueue() {
    audioQueue = [];
    isPlaying = false;
}

function playTranslatedAudio(base64Audio) {
    if (!rtc.audioContext || !rtc.streamDestination) return;
    // Decode base64 to Int16Array
    const binaryString = atob(base64Audio);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
    }
    const length = bytes.length - (bytes.length % 2);
    const int16Array = new Int16Array(bytes.buffer.slice(0, length));
    // Add to queue and play
    enqueueAndPlayTranslatedAudio(int16Array);
}

function enqueueAndPlayTranslatedAudio(int16Array) {
    audioQueue.push(int16Array);
    if (!isPlaying) {
        isPlaying = true;
        playNextInQueue();
    }
}

function playNextInQueue() {
    if (audioQueue.length === 0) {
        isPlaying = false;
        return;
    }
    // Combine all queued chunks
    const totalLength = audioQueue.reduce((acc, arr) => acc + arr.length, 0);
    const combinedArray = new Int16Array(totalLength);
    let offset = 0;
    for (const chunk of audioQueue) {
        combinedArray.set(chunk, offset);
        offset += chunk.length;
    }
    audioQueue = [];
    // Create and play AudioBuffer
    const audioBuffer = rtc.audioContext.createBuffer(1, combinedArray.length, 24000);
    const channelData = audioBuffer.getChannelData(0);
    for (let i = 0; i < combinedArray.length; i++) {
        channelData[i] = combinedArray[i] / 32768.0;
    }
    const source = rtc.audioContext.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(rtc.streamDestination);
    source.onended = () => {
        if (audioQueue.length > 0) {
            playNextInQueue();
        } else {
            isPlaying = false;
        }
    };
    source.start();
}

// --- Core Functions ---

async function setupAudio() {
    try {
        recorder = new WavRecorder({ sampleRate: 24000 });
        await recorder.begin();
        player = new WavStreamPlayer({ sampleRate: 24000 });
        await player.connect();
        return true;
    } catch (error) {
        console.error('Error setting up audio devices:', error);
        return false;
    }
}

async function startSession() {
    if (ws) return;
    
    if (!await setupAudio()) {
        console.error('Failed to setup audio devices');
        return;
    }
    
    ws = new WebSocket(`ws://${window.location.host}`);
    
    ws.onopen = async () => {
        console.log('WebSocket connected successfully');
        isConnected = true;
        
        updateButtonStates(true);
        updateTranslationStatusUI(true, sourceLanguage, targetLanguage);
        
        // Initialize session with current language settings
        updateSessionInstructions();
    };
    
    setupWebSocketHandlers();
}

function stopSession() {
    if (!ws) return;
    if (ws.readyState === WebSocket.OPEN) {
        ws.close();
    }
    ws = null;
    isConnected = false;
    
    if (isRecording) {
        isRecording = false;
        const pttButton = document.getElementById('pushToTalk');
        if (pttButton) {
            pttButton.classList.remove('recording');
        }
    }
    
    if (recorder) {
        recorder.end();
        recorder = null;
    }
    if (player) {
        player = null;
    }
    
    updateButtonStates(false);
    updateTranslationStatusUI(false);
}

function setupWebSocketHandlers() {
    if (!ws) return;
    
    ws.onmessage = async (event) => {
        try {
            const data = JSON.parse(event.data);
            console.log('Received WebSocket message:', data.type);
            addLogEntry(data);
            
            if (data.type === 'response.audio.delta') {
                // Play translated audio into the custom track if translation is enabled
                // if (isTranslationEnabled) {
                //     playTranslatedAudio(data.delta);
                // } else {
                    // Fallback: play locally for preview
                    const binaryString = atob(data.delta);
                    const len = binaryString.length;
                    const bytes = new Uint8Array(len);
                    for (let i = 0; i < len; i++) {
                        bytes[i] = binaryString.charCodeAt(i);
                    }
                    playTranslatedAudio(data.delta);
                    await player.add16BitPCM(new Int16Array(bytes.buffer), data.item_id);
              //  }
            } else if (data.type === 'response.audio_transcript.done') {
                updateTranscript('assistant', data.transcript);
            } else if (data.type === 'conversation.item.input_audio_transcription.completed') {
                updateTranscript('user', data.transcript);
            } else if (data.type === 'response.audio.done') {
                console.log('Audio response completed');
            } else if (data.type === 'response.done') {
                console.log('Response completed');
            } else if (data.type === 'error') {
                console.error('Server error:', data.error);
            }
        } catch (e) {
            console.error('Error processing WebSocket message:', e);
        }
    };

    ws.onerror = (error) => {
        console.error('WebSocket error:', error);
        isConnected = false;
        updateButtonStates(false);
        updateTranslationStatusUI(false);
    };

    ws.onclose = async () => {
        console.log('WebSocket closed');
        isConnected = false;
        updateButtonStates(false);
        updateTranslationStatusUI(false);
        
        if (recorder && recorder.getStatus() === 'recording') {
            await recorder.pause();
        }
        isRecording = false;
    };
}

async function startRecording() {
    if (!isConnected || !recorder) return;
    if (isRecording) return;
    
    isRecording = true;
    const pttButton = document.getElementById('pushToTalk');
    if (pttButton) {
        pttButton.classList.add('recording');
    }
    
    // For manual mode, first create a conversation item
    if (isManualMode) {
        ws.send(JSON.stringify({
            type: 'conversation.item.create',
            item: {
                type: 'message',
                role: 'user',
                content: [{ type: 'input_text', text: '' }]
            }
        }));
    }
    
    // Then start recording and sending audio data
    try {
        await recorder.record((data) => {
            if (ws?.readyState === WebSocket.OPEN) {
                const bytes = new Int16Array(data.mono); // Use mono channel
                const buffer = new ArrayBuffer(bytes.length * 2);
                const view = new DataView(buffer);
                
                for (let i = 0; i < bytes.length; i++) {
                    view.setInt16(i * 2, bytes[i], true);
                }
                
                const base64Audio = btoa(
                    String.fromCharCode(...new Uint8Array(buffer))
                );
                
                ws.send(JSON.stringify({
                    type: 'input_audio_buffer.append',
                    audio: base64Audio
                }));
            }
        });
    } catch (error) {
        console.error('Error starting recording:', error);
    }
}

async function stopRecording() {
    if (!isConnected || !recorder || !isRecording) return;
    if (!isManualMode) return;
    
    isRecording = false;
    const pttButton = document.getElementById('pushToTalk');
    if (pttButton) {
        pttButton.classList.remove('recording');
    }
    
    await recorder.pause();
    
    // Send buffer commit first
    ws.send(JSON.stringify({
        type: 'input_audio_buffer.commit'
    }));
    // Generate response in manual mode
    ws.send(JSON.stringify({
        type: 'response.create'
    }));
}

async function changeTurnEndType(mode) {
    if (!ws) return;
    
    isManualMode = (mode === 'manual');
    
    if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
            type: 'session.update',
            session: {
                turn_detection: isManualMode ? null : { type: 'server_vad' }
            }
        }));
        
        if (!isManualMode) {
            await startRecording();
        } else if (recorder && recorder.getStatus() === 'recording') {
            await recorder.pause();
        }
    }
    
    updateButtonStates(isConnected);
}

function updateSessionInstructions() {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    
    const instructions = `You are a translation assistant. Your role is to translate audio from ${sourceLanguage} to ${targetLanguage} accurately. Do not add, omit, or alter any information—just provide a clear, direct translation. No explanations or additional comments should be given. Your focus is solely on translating between ${sourceLanguage} and ${targetLanguage}. Personality:- Be upbeat and genuine - Try speaking quickly as if excited`;
    
    ws.send(JSON.stringify({
        type: 'session.update',
        session: {
            instructions: instructions,
            turn_detection: null,
            input_audio_transcription: { model: 'whisper-1' },
            voice: 'verse',
        }
    }));
}

// --- UI Update Functions ---

function updateButtonStates(isSessionActive) {
    const toggleBtns = document.querySelectorAll('.toggle-btn');
    const pttButton = document.getElementById('pushToTalk');
    const isManual = document.querySelector('.toggle-btn[data-mode="manual"]')?.classList.contains('active');
    
    if (pttButton) {
        pttButton.style.display = isManual ? 'flex' : 'none';
    }

    if (isSessionActive) {
        toggleBtns.forEach(btn => btn.disabled = false);
        if (pttButton) pttButton.disabled = !isManual;
    } else {
        toggleBtns.forEach(btn => btn.disabled = true);
        if (pttButton) pttButton.disabled = true;
    }
}

function updateTranslationStatusUI(isActive, sourceLang = '', targetLang = '') {
    const statusContainer = document.getElementById('translation-status');
    if (!statusContainer) return;
    if (isActive) {
        const sourceShort = sourceLang.slice(0, 2).toUpperCase();
        const targetShort = targetLang.slice(0, 2).toUpperCase();
        statusContainer.classList.add('active');
        statusContainer.innerHTML = `
            <span class="status-dot"></span>
            <span>Translation: ${sourceShort} → ${targetShort}</span>
            <button id="disable-translation-btn" class="disable-btn">Disable</button>
        `;
        document.getElementById('disable-translation-btn').addEventListener('click', stopSession);
        } else {
        statusContainer.classList.remove('active');
        statusContainer.innerHTML = `
            <span class="status-dot"></span>
            <span>Translation: Disabled</span>
        `;
    }
}

function addLogEntry(data) {
    const logsContainer = document.getElementById('logsContainer');
    if (!logsContainer) return;
    const timestamp = new Date().toISOString().substr(11, 8);
    const logEntry = document.createElement('div');
    logEntry.className = 'log-entry';
    // Determine arrow direction based on message type
    const isUpward = data.type && (data.type.startsWith('input') || data.type === 'response.create');
    logEntry.innerHTML = `
        <span class="log-time">${timestamp}</span>
        <span class="log-arrow ${isUpward ? 'up' : 'down'}"></span>
        <span class="log-type">${data.type}</span>
        ${data.count ? `<span class="log-count">(${data.count})</span>` : ''}
    `;
    if (logsContainer) {
        logsContainer.appendChild(logEntry);
        // Auto-scroll to bottom
        logsContainer.scrollTop = logsContainer.scrollHeight;
        // Limit log size
        if (logsContainer.children.length > 100) {
            logsContainer.removeChild(logsContainer.firstChild);
        }
    }
}

function updateTranscript(role, text) {
    const elementId = role === 'user' ? 'user-transcript' : 'assistant-transcript';
    const transcriptEl = document.getElementById(elementId);
    if(transcriptEl) {
        transcriptEl.textContent = text;
        const estimatedDuration = (text.split(' ').length * 200); // ~200ms per word
        highlightSpokenText(text, 'assistant-transcript',estimatedDuration);
    }
}

// Add this new function to handle highlighting
function highlightSpokenText(text, elementId, duration = 2000) { // duration in milliseconds
    const element = document.getElementById(elementId);
    if (!element) return;

    // Create spans for each word
    const words = text.split(' ');
    const htmlContent = words.map((word, index) => 
        `<span class="word" data-index="${index}">
            <span class="text">${word}</span>
         </span>`
    ).join(' ');
    
    element.innerHTML = htmlContent;
    wordElements = element.querySelectorAll('.word');
    currentWordIndex = 0;

    // Clear any existing interval
    if (highlightInterval) {
        clearInterval(highlightInterval);
    }

    // Calculate timing between words
    const intervalTime = duration / words.length;

    // Set up the highlighting interval
    highlightInterval = setInterval(() => {
        if (currentWordIndex < wordElements.length) {
            // Add highlight to current word (no removal of previous highlights)
            wordElements[currentWordIndex].classList.add('highlighted');
            currentWordIndex++;
        } else {
            // Clear interval when done
            clearInterval(highlightInterval);
            highlightInterval = null;
        }
    }, intervalTime);
}

// Add cleanup function for when we need to reset
function cleanup() {
    if (highlightInterval) {
        clearInterval(highlightInterval);
        highlightInterval = null;
    }
    wordElements = [];
    currentWordIndex = 0;
}

// --- Agora Functions ---

async function loadAgoraConfig() {
    try {
        const response = await fetch('/config/agora');
        if (!response.ok) throw new Error('Failed to load Agora configuration');
        agoraOptions = await response.json();
    } catch (error) {
        console.error('Error loading Agora configuration:', error);
    }
}

async function joinCall() {
    try {
        if (!agoraOptions) {
            console.error("Agora config not loaded");
            return;
        }
        
        if (rtc.client) {
            console.log("Already in call, leaving first...");
            await leaveCall();
        }
        
        rtc.client = AgoraRTC.createClient({ mode: "rtc", codec: "vp8" });

        // Add event listeners for remote users
        rtc.client.on("user-published", handleUserPublished);
        rtc.client.on("user-unpublished", handleUserUnpublished);
        rtc.client.on("user-left", handleUserLeft);
        
        await rtc.client.join(agoraOptions.appId, agoraOptions.channel, agoraOptions.token, agoraOptions.uid);
        
        rtc.localVideoTrack = await AgoraRTC.createCameraVideoTrack();
        isVideoEnabled = true; // Set initial state
        
        // If translation is enabled, use custom track
        if (isTranslationEnabled) {
            await setupTranslatedAudioRouting();
            await rtc.client.publish([rtc.customAudioTrack, rtc.localVideoTrack]);
        } else {
            if (!rtc.localAudioTrack) {
                rtc.localAudioTrack = await AgoraRTC.createMicrophoneAudioTrack();
            }
            await rtc.client.publish([rtc.localAudioTrack, rtc.localVideoTrack]);
        }
        rtc.isInCall = true;
        const selfVideoContainer = document.getElementById('self-video');
        if (selfVideoContainer) {
            // Hide placeholder and play video
            const placeholder = selfVideoContainer.querySelector('.video-placeholder');
            if (placeholder) {
                placeholder.style.display = 'none';
            }
            rtc.localVideoTrack.play(selfVideoContainer);
        }
        
        console.log("Successfully joined call!");
        
        // Update UI to show we're in call
        const joinButton = document.getElementById('join');
        const endCallButton = document.querySelector('.end-call-btn');
        if (joinButton) joinButton.style.display = 'none';
        if (endCallButton) endCallButton.style.display = 'block';
        
    } catch (error) {
        console.error("Error joining call:", error);
        // Clean up on error
        if (rtc.localAudioTrack) {
            rtc.localAudioTrack.close();
            rtc.localAudioTrack = null;
        }
        if (rtc.localVideoTrack) {
            rtc.localVideoTrack.close();
            rtc.localVideoTrack = null;
        }
        if (rtc.client) {
            rtc.client = null;
        }
    }
}

async function leaveCall() {
    try {
        if (!rtc.client) {
            console.log("Not in call");
            return;
        }
        
        if (rtc.localAudioTrack) {
            rtc.localAudioTrack.close();
            rtc.localAudioTrack = null;
        }
        if (rtc.localVideoTrack) {
            rtc.localVideoTrack.close();
            rtc.localVideoTrack = null;
        }
        if (rtc.customAudioTrack) {
            rtc.customAudioTrack.close();
            rtc.customAudioTrack = null;
        }
        if (rtc.audioContext) {
            rtc.audioContext.close();
            rtc.audioContext = null;
        }
        rtc.streamDestination = null;
        rtc.isInCall = false;
        await rtc.client.leave();
        rtc.client = null;
        
        console.log("Successfully left call");
        
        // Show placeholder again
        const selfVideoContainer = document.getElementById('self-video');
        if (selfVideoContainer) {
            const placeholder = selfVideoContainer.querySelector('.video-placeholder');
            if (placeholder) {
                placeholder.style.display = 'flex';
            }
        }
        
        // Update UI to show we're not in call
        const joinButton = document.getElementById('join');
        const endCallButton = document.querySelector('.end-call-btn');
        if (joinButton) joinButton.style.display = 'block';
        if (endCallButton) endCallButton.style.display = 'none';
        
        // Reset video button UI
        const videoButton = document.getElementById('toggle-video-btn');
        if (videoButton) {
             videoButton.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 7l-7 5 7 5V7z"></path><rect x="1" y="5" width="15" height="14" rx="2" ry="2"></rect></svg>`;
        }
        
        // Remove all remote user panels
        const videoGrid = document.getElementById('video-grid');
        [...videoGrid.querySelectorAll('.video-panel')].forEach(panel => {
            // Don't remove the self-panel (local user)
            if (!panel.classList.contains('self-panel')) {
                panel.remove();
            }
        });
        updateGridLayout();
        
    } catch (error) {
        console.error("Error leaving call:", error);
        // Force cleanup on error
        rtc.localAudioTrack = null;
        rtc.localVideoTrack = null;
        rtc.customAudioTrack = null;
        rtc.audioContext = null;
        rtc.streamDestination = null;
        rtc.client = null;
        rtc.isInCall = false;
    }
}

function updateGridLayout() {
    const grid = document.getElementById('video-grid');
    const participants = grid.children.length;

    // Remove all layout classes first
    grid.className = 'video-grid';

    if (participants <= 2) {
        grid.classList.add('layout-2');
    } else if (participants <= 4) {
        grid.classList.add('layout-4');
    } else if (participants <= 9) {
        grid.classList.add('layout-9');
    } else {
        grid.classList.add('layout-12');
    }
}

async function handleUserPublished(user, mediaType) {
    await rtc.client.subscribe(user, mediaType);
    console.log(`Subscribed to ${user.uid}, mediaType: ${mediaType}`);

    const videoGrid = document.getElementById('video-grid');
    let playerContainer = document.getElementById(`player-wrapper-${user.uid}`);

    if (!playerContainer) {
        playerContainer = document.createElement('div');
        playerContainer.id = `player-wrapper-${user.uid}`;
        playerContainer.className = 'video-panel';
        
        const soundBars = document.createElement('div');
        soundBars.className = 'sound-bars';
        soundBars.innerHTML = `<div class="bar"></div><div class="bar"></div><div class="bar"></div>`;

        const videoCircleContainer = document.createElement('div');
        videoCircleContainer.className = 'video-circle-container';

        const videoCircle = document.createElement('div');
        videoCircle.className = 'video-circle';

        const videoPlaceholder = document.createElement('div');
        videoPlaceholder.className = 'video-placeholder';

        const avatarImg = document.createElement('img');
        avatarImg.alt = 'User illustration';
        avatarImg.className = 'avatar-illustration';
        
        videoPlaceholder.appendChild(avatarImg);
        videoCircle.appendChild(videoPlaceholder);
        videoCircleContainer.appendChild(videoCircle);

        const panelInfo = document.createElement('div');
        panelInfo.className = 'panel-info';

        const nameTag = document.createElement('span');
        nameTag.className = 'name-tag';
        nameTag.textContent = `User ${user.uid}`;

        const micIcon = document.createElement('span');
        micIcon.className = 'mic-icon';
        micIcon.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"></path><path d="M19 10v2a7 7 0 0 1-14 0v-2"></path><line x1="12" x2="12" y1="19" y2="22"></line></svg>`;
        
        panelInfo.appendChild(nameTag);
        panelInfo.appendChild(micIcon);

        playerContainer.appendChild(soundBars);
        playerContainer.appendChild(videoCircleContainer);
        playerContainer.appendChild(panelInfo);

        videoGrid.appendChild(playerContainer);
        setupPlaceholderForElement(videoPlaceholder);
        updateGridLayout();
    }

    const videoCircle = playerContainer.querySelector('.video-circle');
    if (mediaType === 'video' && user.videoTrack) {
        const placeholder = videoCircle.querySelector('.video-placeholder');
        if (placeholder) {
            placeholder.style.display = 'none';
        }
        user.videoTrack.play(videoCircle);
    }
    
    if (mediaType === 'audio' && user.audioTrack) {
        user.audioTrack.play();
    }
}

function handleUserUnpublished(user, mediaType) {
    if (mediaType === 'video') {
        const playerContainer = document.getElementById(`player-wrapper-${user.uid}`);
        if (playerContainer) {
            const placeholder = playerContainer.querySelector('.video-circle .video-placeholder');
            if (placeholder) {
                placeholder.style.display = 'flex';
            }
        }
    }
}

function handleUserLeft(user) {
    const playerContainer = document.getElementById(`player-wrapper-${user.uid}`);
    if (playerContainer) {
        playerContainer.remove();
        updateGridLayout();
    }
    console.log(`User ${user.uid} has left.`);
}

function setupPlaceholderForElement(element) {
    const illustrations = ['/assets/openpeeps_1.png', '/assets/openpeeps_2.png', '/assets/openpeeps_3.png'];
    const bgColors = ['#E6E6FA', '#D8BFD8', '#B0E0E6', '#ADD8E6', '#F0E68C', '#98FB98'];
    const randomIllustration = illustrations[Math.floor(Math.random() * illustrations.length)];
    const randomColor = bgColors[Math.floor(Math.random() * bgColors.length)];
    
    element.style.backgroundColor = randomColor;
    const img = element.querySelector('.avatar-illustration');
    if (img) {
        img.src = randomIllustration;
    }
}

function setupDynamicPlaceholders() {
    const placeholders = document.querySelectorAll('.video-placeholder');
    const illustrations = ['openpeeps_1.png', 'openpeeps_2.png', 'openpeeps_3.png'];
    const bgColors = ['#E6E6FA', '#D8BFD8', '#B0E0E6', '#ADD8E6', '#F0E68C', '#98FB98'];

    placeholders.forEach(p => {
        const randomIllustration = illustrations[Math.floor(Math.random() * illustrations.length)];
        const randomColor = bgColors[Math.floor(Math.random() * bgColors.length)];
        
        p.style.backgroundColor = randomColor;
        const img = p.querySelector('.avatar-illustration');
        if (img) {
            img.src = `/assets/${randomIllustration}`;
        }
        setupPlaceholderForElement(p);
    });
}

async function toggleVideo() {
    if (!rtc.localVideoTrack || !rtc.client) {
        console.log("Cannot toggle video. Not in a call or no video track.");
        return;
    }

    isVideoEnabled = !isVideoEnabled;
    await rtc.localVideoTrack.setEnabled(isVideoEnabled);

    // Update UI for the local user
    const selfVideoContainer = document.getElementById('self-video');
    const placeholder = selfVideoContainer.querySelector('.video-placeholder');
    const videoButton = document.getElementById('toggle-video-btn');

    if (isVideoEnabled) {
        if (placeholder) placeholder.style.display = 'none';
        videoButton.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 7l-7 5 7 5V7z"></path><rect x="1" y="5" width="15" height="14" rx="2" ry="2"></rect></svg>`;
    } else {
        if (placeholder) placeholder.style.display = 'flex';
        videoButton.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 16v1a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h2m5.66 0H14a2 2 0 0 1 2 2v3.34l1 1L23 7v10"></path><line x1="1" y1="1" x2="23" y2="23"></line></svg>`;
    }
}

function setupCustomSelects() {
    const customSelects = document.querySelectorAll('.custom-select');

    customSelects.forEach(select => {
        const trigger = select.querySelector('.custom-select-trigger');
        const options = select.querySelectorAll('.custom-option');
        const selectedText = trigger.querySelector('.selected-language-text');
        const selectedFlag = trigger.querySelector('.selected-language-flag');

        trigger.addEventListener('click', () => {
            customSelects.forEach(s => {
                if (s !== select) s.classList.remove('open');
            });
            select.classList.toggle('open');
        });

        options.forEach(option => {
            option.addEventListener('click', () => {
                const previouslySelected = select.querySelector('.custom-option.selected');
                if (previouslySelected) previouslySelected.classList.remove('selected');
                
                option.classList.add('selected');
                selectedText.textContent = option.dataset.value;
                selectedFlag.textContent = option.dataset.flag;
                
                if (select.id === 'source-language-select') {
                    sourceLanguage = option.dataset.value;
                } else {
                    targetLanguage = option.dataset.value;
                }

                // if (isConnected) updateSessionInstructions();
                if (isConnected) {
                    updateSessionInstructions();
                     // Re-publish the custom audio track so Agora gets the new translation
                    resetAudioQueue();
                    if (isTranslationEnabled && rtc.client && rtc.customAudioTrack) {
                        rtc.client.unpublish(rtc.customAudioTrack).then(async () => {
                            await rtc.client.publish([rtc.customAudioTrack, rtc.localVideoTrack]);
                        });
                    }

                    // Test code :might be removed later
                // if (ws && ws.readyState === WebSocket.OPEN) {
                //   //  ws.send(JSON.stringify({ type: 'input_audio_buffer.clear' }));
                //     ws.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
                //     ws.send(JSON.stringify({ type: 'response.create' }));
                // }
                }
                updateSummary();
                select.classList.remove('open');
            });
        });
    });

    // Close dropdowns if user clicks outside
    window.addEventListener('click', (e) => {
        customSelects.forEach(select => {
            if (!select.contains(e.target)) {
                select.classList.remove('open');
            }
        });
    });
}

function updateSummary() {
    const sourceText = document.querySelector('#source-language-select .selected-language-text').textContent;
    const targetText = document.querySelector('#target-language-select .selected-language-text').textContent;
    const summarySource = document.getElementById('summary-source');
    const summaryTarget = document.getElementById('summary-target');

    summarySource.textContent = sourceText;
    summaryTarget.textContent = targetText;
}

function swapLanguages() {
    const sourceSelect = document.getElementById('source-language-select');
    const targetSelect = document.getElementById('target-language-select');

    const sourceLangValue = sourceSelect.querySelector('.custom-option.selected').dataset.value;
    const sourceLangFlag = sourceSelect.querySelector('.custom-option.selected').dataset.flag;
    const targetLangValue = targetSelect.querySelector('.custom-option.selected').dataset.value;
    const targetLangFlag = targetSelect.querySelector('.custom-option.selected').dataset.flag;
    
    // Update source select
    sourceSelect.querySelector('.selected-language-text').textContent = targetLangValue;
    sourceSelect.querySelector('.selected-language-flag').textContent = targetLangFlag;
    sourceSelect.querySelector('.custom-option.selected').classList.remove('selected');
    sourceSelect.querySelector(`.custom-option[data-value="${targetLangValue}"]`).classList.add('selected');
    sourceLanguage = targetLangValue;

    // Update target select
    targetSelect.querySelector('.selected-language-text').textContent = sourceLangValue;
    targetSelect.querySelector('.selected-language-flag').textContent = sourceLangFlag;
    targetSelect.querySelector('.custom-option.selected').classList.remove('selected');
    targetSelect.querySelector(`.custom-option[data-value="${sourceLangValue}"]`).classList.add('selected');
    targetLanguage = sourceLangValue;

    if (isConnected) updateSessionInstructions();
    updateSummary();
}

// --- Translation Enable/Disable Logic ---
// Call this when translation is enabled/disabled from the UI
async function setTranslationEnabled(enabled) {
    isTranslationEnabled = enabled;
    resetAudioQueue();
    if (rtc.client) {
        if (rtc.localAudioTrack) {
            await rtc.client.unpublish(rtc.localAudioTrack);
            rtc.localAudioTrack.close();
            rtc.localAudioTrack = null;
        }
        if (rtc.customAudioTrack) {
            await rtc.client.unpublish(rtc.customAudioTrack);
       //     rtc.customAudioTrack.close();
       //     rtc.customAudioTrack = null;
        }
        if (enabled) {
            await setupTranslatedAudioRouting();
            await rtc.client.publish([rtc.customAudioTrack, rtc.localVideoTrack]);
        } else {
            if (!rtc.localAudioTrack) {
                rtc.localAudioTrack = await AgoraRTC.createMicrophoneAudioTrack();
            }
            await rtc.client.publish([rtc.localAudioTrack, rtc.localVideoTrack]);
        }
    }
}

// --- Main Initialization ---

document.addEventListener('DOMContentLoaded', () => {
    // Get all DOM Elements
    const sourceLanguageSelect = document.getElementById('sourceLanguage');
    const targetLanguageSelect = document.getElementById('targetLanguage');
    const toggleButtons = document.querySelectorAll('.toggle-btn');
    const pttButton = document.getElementById('pushToTalk');
    const logsButton = document.getElementById('toggleLogs');
    const logsSidebar = document.getElementById('logsSidebar');
    const clearLogsButton = document.getElementById('clearLogs');
    const enableTranslationBtn = document.getElementById('enable-translation-btn');
    const settingsPanel = document.getElementById('translation-settings-panel');
    const openSettingsBtn = document.getElementById('translate-settings-btn');
    const closeSettingsBtn = document.getElementById('close-settings-btn');
    const joinButton = document.getElementById('join');
    const endCallButton = document.querySelector('.end-call-btn');
    const toggleVideoButton = document.getElementById('toggle-video-btn');
    const swapLanguagesBtn = document.getElementById('swap-languages-btn');

    // Add Event Listeners
    toggleButtons.forEach(btn => {
        btn.addEventListener('click', (e) => {
            if (btn.disabled) return;
            toggleButtons.forEach(b => b.classList.remove('active'));
            e.currentTarget.classList.add('active');
            changeTurnEndType(e.currentTarget.dataset.mode);
        });
    });

    // Push-to-talk functionality
    if (pttButton) {
        pttButton.addEventListener('mousedown', async () => {
            if (!isConnected || !isManualMode) return;
            await startRecording();
        });
        
        pttButton.addEventListener('mouseup', async () => {
            if (!isConnected || !isManualMode) return;
            await stopRecording();
        });
        
        pttButton.addEventListener('touchstart', async () => {
            if (!isConnected || !isManualMode) return;
            await startRecording();
        });
        
        pttButton.addEventListener('touchend', async () => {
            if (!isConnected || !isManualMode) return;
            await stopRecording();
        });
        
        pttButton.addEventListener('mouseleave', async () => {
            if (isRecording) await stopRecording();
        });
    }

    // Logs sidebar functionality
    if (logsButton && logsSidebar) {
        logsButton.addEventListener('click', () => {
            logsSidebar.classList.toggle('open');
            // Update button text to indicate state
            if (logsSidebar.classList.contains('open')) {
                logsButton.textContent = 'Close Logs';
            } else {
                logsButton.textContent = 'Logs';
            }
        });
    }
    
    if (clearLogsButton) {
        clearLogsButton.addEventListener('click', () => {
            const logsContainer = document.getElementById('logsContainer');
            if (logsContainer) logsContainer.innerHTML = '';
        });
    }

    // Settings panel functionality
    if (openSettingsBtn && settingsPanel) {
        openSettingsBtn.addEventListener('click', () => {
            // Close logs sidebar if open to prevent overlap
            if (logsSidebar && logsSidebar.classList.contains('open')) {
                logsSidebar.classList.remove('open');
                if (logsButton) logsButton.textContent = 'Logs';
            }
            settingsPanel.classList.remove('hidden');
        });
    }
    
    if (closeSettingsBtn && settingsPanel) {
        closeSettingsBtn.addEventListener('click', () => {
            settingsPanel.classList.add('hidden');
        });
    }

    if (enableTranslationBtn) {
        enableTranslationBtn.addEventListener('click', () => {
            setTranslationEnabled(true); 
            startSession();
            if (settingsPanel) settingsPanel.classList.add('hidden');
        });
    }

    if (joinButton) {
        joinButton.addEventListener('click', joinCall);
    }

    if (endCallButton) {
        endCallButton.addEventListener('click', leaveCall);
    }

    if (toggleVideoButton) {
        toggleVideoButton.addEventListener('click', toggleVideo);
    }

    if (swapLanguagesBtn) {
        swapLanguagesBtn.addEventListener('click', swapLanguages);
    }

    setupCustomSelects();

    // Set Initial UI State
    updateButtonStates(false);
    updateTranslationStatusUI(false);
    
    // Set initial call button states
    if (joinButton) joinButton.style.display = 'block';
    if (endCallButton) endCallButton.style.display = 'none';
    
    loadAgoraConfig();
    setupDynamicPlaceholders();
    updateGridLayout();
});
