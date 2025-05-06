// Simple Twilio voice agent with webhook approach instead of ConversationRelay
// This uses Twilio's built-in speech recognition instead of WebSockets
// Now enhanced with OpenAI Assistants API for persistent memory and tool calling
import express from 'express';
import { OpenAI } from 'openai';
import twilio from 'twilio';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { initializeAssistant, ensureThreadForPhoneNumber, getAssistantResponse } from './assistants-util.js';

// Initialize environment
dotenv.config();

// Get directory path for ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Constants 
const PORT = process.env.PORT || 8080;
const SYSTEM_PROMPT = `You are the Lead Agent for AI Taskforce, a specialized system with 6 agents:
- Lead Agent (you): Handle scheduled calls and coordinate other agents
- Web Scraper: Gather information from web sources
- Copywriter: Create content based on information
- Graphic Designer: Generate images and visual assets
- Social Media Manager: Post content to social platforms
- Project Manager: Handle approvals and coordination

Respond helpfully and professionally to voice queries. Spell out numbers (say 'twenty' not '20').
Keep responses concise as they will be spoken aloud.`;

// Track active sessions
const sessions = new Map();

// API key handling - get from environment or env file
let apiKey = process.env.OPENAI_API_KEY;

// If not in environment, try to read from .env files
if (!apiKey) {
  const envFiles = [
    path.join(__dirname, '.env.local'),
    path.join(__dirname, '.env'),
    path.join(__dirname, 'functions', '.env.local'),
    path.join(__dirname, 'functions', '.env')
  ];
  
  for (const envFile of envFiles) {
    if (fs.existsSync(envFile)) {
      const envContent = fs.readFileSync(envFile, 'utf8');
      const keyMatch = envContent.match(/OPENAI_API_KEY=(.+)$/m);
      if (keyMatch && keyMatch[1]) {
        apiKey = keyMatch[1].trim();
        if (apiKey.endsWith('$')) {
          apiKey = apiKey.slice(0, -1);
          console.log(`Removed trailing $ from API key in ${envFile}`);
        }
        break;
      }
    }
  }
}

if (!apiKey) {
  console.error('❌ No OpenAI API key found. Please set OPENAI_API_KEY in your environment or .env file.');
  process.exit(1);
}

console.log(`API Key length: ${apiKey.length}`);
console.log(`API Key prefix: ${apiKey.substring(0, 10)}...`);

// Initialize OpenAI clients - both standard and Assistants API
const openai = new OpenAI({
  apiKey
});

// Initialize the Assistant
initializeAssistant(apiKey).catch(error => {
  console.error('Failed to initialize Assistant:', error);
  process.exit(1);
});

// Firebase initialization
let db = null;

// Conversations storage (for demo mode when no Firebase)
const conversations = new Map();

// Check if we should use mock mode
const useMockFirebase = false; // Set to false when using real Firebase

if (useMockFirebase) {
  console.log('💻 Using mock Firebase mode for demonstration purposes');
  
  // Create a simple mock Firestore-like interface
  db = {
    collection: (name) => {
      return {
        doc: (id) => {
          return {
            get: async () => {
              return {
                exists: conversations.has(id),
                data: () => conversations.get(id) || {}
              };
            },
            set: async (data) => {
              conversations.set(id, data);
              console.log(`🔥 Mock Firestore: Created document in ${name} with ID ${id}`);
              return true;
            },
            update: async (data) => {
              const existing = conversations.get(id) || {};
              const updated = { ...existing, ...data };
              
              // Special handling for arrayUnion
              if (data.messages && data.messages._arrayUnion) {
                if (!updated.messages) updated.messages = [];
                // Make sure messages is an array
                if (!Array.isArray(updated.messages)) {
                  updated.messages = [];
                }
                updated.messages.push(data.messages._arrayUnion);
                console.log(`Added message to conversation ${id}: ${JSON.stringify(data.messages._arrayUnion).substring(0, 100)}...`);
              }
              
              conversations.set(id, updated);
              console.log(`🔥 Mock Firestore: Updated document in ${name} with ID ${id}`);
              return true;
            }
          };
        },
        limit: () => ({
          get: async () => ({
            size: conversations.size,
            docs: [...conversations.entries()].map(([id, data]) => ({
              id,
              data: () => data
            }))
          })
        })
      };
    }
  };
  
  // Mock the Firebase admin FieldValue.arrayUnion function
  global.admin = {
    firestore: {
      FieldValue: {
        arrayUnion: (item) => ({ _arrayUnion: item })
      }
    }
  };
  
  console.log('✅ Mock Firebase initialized successfully');
} else {
  // Real Firebase initialization
  try {
    // Look for Firebase credentials
    const serviceAccountPath = path.join(__dirname, 'functions', 'agentc-13331-firebase-adminsdk.json');
    
    if (fs.existsSync(serviceAccountPath)) {
      console.log('✅ Firebase credentials found - initializing Firebase');
      
      // Import Firebase packages - use a different approach for ES modules
      try {
        // First, import the package
        const admin = await import('firebase-admin');
        
        // Access the default export
        const { default: firebaseAdmin } = admin;
        
        // Initialize Firebase with the service account
        firebaseAdmin.initializeApp({
          credential: firebaseAdmin.credential.cert(JSON.parse(fs.readFileSync(serviceAccountPath, 'utf8')))
        });
        
        // Store references for later use
        global.admin = firebaseAdmin;
        db = firebaseAdmin.firestore();
        
        console.log('🔥 Firebase and Firestore initialized successfully');
        
        // Create the conversation collection if it doesn't exist
        try {
          // Check if the conversations collection exists by making a small query
          const snapshot = await db.collection('conversations').limit(1).get();
          console.log(`✅ Conversations collection ready (${snapshot.size} documents found)`);
        } catch (error) {
          console.warn('⚠️ Error checking conversations collection:', error.message);
        }
      } catch (error) {
        console.error('❌ Error initializing Firebase:', error);
      }
    } else {
      console.warn('⚠️ Firebase credentials not found at', serviceAccountPath);
      console.warn('⚠️ Running without Firebase integration - conversations will not be saved');
    }
  } catch (error) {
    console.error('❌ Firebase initialization error:', error);
  }
}

// Store conversation in Firebase
async function storeConversation(sessionId, data) {
  if (!db) {
    console.log('Firebase not initialized, skipping conversation storage');
    return;
  }
  
  try {
    // Get the current timestamp
    const timestamp = new Date();
    
    // Create a reference to the conversation document
    const conversationRef = db.collection('conversations').doc(sessionId);
    
    // Check if the conversation document exists
    const conversationDoc = await conversationRef.get();
    
    if (!conversationDoc.exists) {
      // Create a new conversation document
      await conversationRef.set({
        sessionId,
        createdAt: timestamp,
        updatedAt: timestamp,
        callSid: data.callSid || sessions.get(sessionId)?.callSid,
        status: 'active',
        messages: []
      });
      
      console.log(`✅ Created new conversation record for session ${sessionId}`);
    }
    
    // Prepare the message data
    const messageData = {
      timestamp,
      ...data
    };
    
    // Add the message to the conversation
    await conversationRef.update({
      updatedAt: timestamp,
      messages: global.admin.firestore.FieldValue.arrayUnion(messageData)
    });
    
    console.log(`✅ Stored conversation message for session ${sessionId}`);
    
    // If this is a user message, analyze it for potential agent tasks
    if (data.type === 'user' && data.content) {
      await analyzeConversation(sessionId, data.content);
    }
    
    return true;
  } catch (error) {
    console.error('❌ Error storing conversation:', error);
    return false;
  }
}

// Analyze user speech for potential agent tasks
async function analyzeConversation(sessionId, userSpeech) {
  if (!db) return;
  
  console.log(`🧠 Analyzing conversation for session ${sessionId}`);
  
  try {
    // Task identification patterns
    const taskPatterns = [
      {
        type: 'reminder',
        triggers: ['remind me', 'remember to', 'don\'t forget', 'set a reminder'],
        agentType: 'lead_agent'
      },
      {
        type: 'research',
        triggers: ['find information', 'research', 'look up', 'search for', 'find out about'],
        agentType: 'web_scraper'
      },
      {
        type: 'content_creation',
        triggers: ['create content', 'write', 'draft', 'compose', 'article about'],
        agentType: 'copywriter'
      },
      {
        type: 'image_creation',
        triggers: ['create image', 'design', 'picture of', 'illustration', 'graphic'],
        agentType: 'graphic_designer'
      },
      {
        type: 'social_post',
        triggers: ['post on', 'share on', 'twitter', 'facebook', 'instagram', 'social media'],
        agentType: 'social_media_manager'
      },
      {
        type: 'approval',
        triggers: ['approve', 'review', 'check', 'sign off'],
        agentType: 'project_manager'
      }
    ];
    
    // Normalize the user speech
    const normalizedSpeech = userSpeech.toLowerCase();
    
    // Check for potential tasks
    for (const pattern of taskPatterns) {
      for (const trigger of pattern.triggers) {
        if (normalizedSpeech.includes(trigger)) {
          console.log(`💡 Detected potential ${pattern.type} task from trigger: "${trigger}"`);
          
          // Store the potential task in Firebase
          const taskData = {
            type: pattern.type,
            agentType: pattern.agentType,
            source: 'voice_call',
            sourceId: sessionId,
            sourceText: userSpeech,
            status: 'potential', // Not a real task yet, just potential
            trigger: trigger,
            createdAt: new Date(),
            executionStatus: 'pending_review' // Would need to be reviewed before execution
          };
          
          await storeAgentTask(taskData);
          return; // Stop after finding the first match to avoid multiple similar tasks
        }
      }
    }
    
    console.log(`ℹ️ No agent tasks identified in speech`);
    
  } catch (error) {
    console.error('❌ Error analyzing conversation:', error);
  }
}

// Store agent task in Firebase
async function storeAgentTask(taskData) {
  if (!db) return;
  
  try {
    // Clean the data to ensure no undefined values
    const cleanTaskData = {};
    
    // Only add properties that have values
    Object.entries(taskData).forEach(([key, value]) => {
      if (value !== undefined && value !== null) {
        cleanTaskData[key] = value;
      }
    });
    
    // Ensure required fields have default values
    const safeTaskData = {
      type: cleanTaskData.type || 'unknown',
      agentType: cleanTaskData.agentType || 'lead_agent',
      source: cleanTaskData.source || 'voice_call',
      sourceText: cleanTaskData.sourceText || '',
      status: cleanTaskData.status || 'potential',
      createdAt: cleanTaskData.createdAt || new Date(),
      executionStatus: cleanTaskData.executionStatus || 'pending_review',
      // Include any other fields that existed
      ...cleanTaskData
    };
    
    // Store in potential_tasks collection
    const docRef = await db.collection('potential_tasks').add(safeTaskData);
    console.log(`✅ Stored potential task with ID: ${docRef.id}`);
    
    // For reminders specifically, create a dedicated reminder document
    if (safeTaskData.type === 'reminder') {
      await db.collection('reminders').add({
        ...safeTaskData,
        message: safeTaskData.sourceText || 'Reminder (no details provided)',
        taskId: docRef.id
      });
      console.log(`⏰ Created reminder from voice conversation`);
    }
    
    return docRef.id;
  } catch (error) {
    console.error('❌ Error storing agent task:', error);
    return null;
  }
}

// Mark conversation as completed
async function completeConversation(sessionId) {
  if (!db) return;
  
  try {
    const conversationRef = db.collection('conversations').doc(sessionId);
    const conversationDoc = await conversationRef.get();
    
    if (conversationDoc.exists) {
      await conversationRef.update({
        status: 'completed',
        completedAt: new Date()
      });
      
      console.log(`✅ Marked conversation ${sessionId} as completed`);
    }
  } catch (error) {
    console.error('❌ Error completing conversation:', error);
  }
}

// Create Express app
const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Serve static files from the public directory
app.use(express.static(path.join(__dirname, 'public')));

// Log all requests for debugging
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
  if (req.method === 'POST') {
    console.log('Request body:', req.body);
  }
  next();
});

// Health check endpoint with API key validation
app.get('/health', async (req, res) => {
  let apiStatus = 'unknown';
  let apiError = null;
  
  try {
    // Test the OpenAI API key
    const completion = await openai.chat.completions.create({
      model: 'gpt-3.5-turbo',
      messages: [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: 'Say hello' }
      ],
      max_tokens: 5
    });
    
    apiStatus = 'working';
    console.log('OpenAI API test successful:', completion.choices[0].message.content);
  } catch (error) {
    apiStatus = 'error';
    apiError = error.message;
    console.error('OpenAI API test failed:', error);
  }
  
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    openai: {
      apiKeyConfigured: !!apiKey,
      apiKeyLength: apiKey?.length || 0,
      apiKeyPrefix: apiKey ? apiKey.substring(0, 10) + '...' : 'None',
      apiStatus,
      apiError
    },
    sessions: {
      active: sessions.size
    }
  });
});

// Root endpoint - serve index.html from public directory
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Endpoint to initiate a call from the frontend
app.post('/make-call', async (req, res) => {
  try {
    console.log('📱 Received make-call request:', req.body);
    
    // Validate required parameters
    const { to, url } = req.body;
    if (!to) {
      return res.status(400).json({ success: false, error: 'Missing required parameter: to' });
    }
    
    // Set up Twilio client
    const twilioClient = twilio(process.env.TWILIO_SID, process.env.TWILIO_TOKEN);
    
    // Make the call
    const call = await twilioClient.calls.create({
      to: to,
      from: process.env.TWILIO_PHONE,
      url: url || `${req.protocol}://${req.get('host')}/voice`,
      method: 'POST'
    });
    
    console.log(`📞 Call initiated: ${call.sid}`);
    
    // Return success
    res.json({
      success: true,
      callSid: call.sid,
      status: call.status
    });
  } catch (error) {
    console.error('❌ Error making call:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Voice endpoint for Twilio TwiML - initial greeting
app.post('/voice', async (req, res) => {
  console.log('📞 Incoming voice call');
  
  // Create a unique session ID
  const sessionId = `session_${Date.now()}`;
  
  // Initialize session with system message
  sessions.set(sessionId, {
    messages: [{ role: 'system', content: SYSTEM_PROMPT }],
    lastActivity: Date.now(),
    callSid: req.body.CallSid
  });
  
  // Create TwiML response with <Gather> for speech input
  const twiml = new twilio.twiml.VoiceResponse();
  
  // Greeting message
  twiml.say(
    { voice: 'Polly.Amy', language: 'en-US' },
    'Hello, I am your AI Assistant from Agent Taskforce. How can I help you today?'
  );
  
  // Gather speech input and send to /respond endpoint
  twiml.gather({
    input: 'speech',
    action: `/respond?session=${sessionId}`,
    method: 'POST',
    speechTimeout: 'auto',
    speechModel: 'phone_call',
    enhanced: true
  });
  
  // If no input, prompt again
  twiml.redirect({ method: 'POST' }, `/reprompt?session=${sessionId}`);
  
  // Send TwiML response
  res.set('Content-Type', 'text/xml');
  res.send(twiml.toString());
  
  console.log(`Created session: ${sessionId}`);
  
  // Store initial conversation data in Firebase
  // Clean the data by removing undefined values
  const callData = {
    type: 'system',
    callSid: req.body.CallSid || 'unknown',
    from: req.body.From || 'unknown',
    to: req.body.To || 'unknown',
    content: 'Call initiated'
  };
  
  // Only add direction if it exists
  if (req.body.Direction) {
    callData.direction = req.body.Direction;
  }
  
  // Store the call data in Firebase
  storeConversation(sessionId, callData);
  
  // Initialize thread for this caller's phone number
  if (req.body.From) {
    const callerPhone = req.body.From;
    try {
      // Create or retrieve thread ID for this caller
      const threadId = await ensureThreadForPhoneNumber(callerPhone);
      // Store thread ID in the session
      session.threadId = threadId;
      console.log(`Using thread ${threadId} for caller ${callerPhone}`);
    } catch (error) {
      console.error('Error setting up thread for caller:', error);
      // Continue even if thread creation fails - we'll fall back to direct chat completions
    }
  }
});

// Handle speech input and generate AI response
app.post('/respond', async (req, res) => {
  // Get session from query parameter
  const sessionId = req.query.session;
  
  // Create TwiML response
  const twiml = new twilio.twiml.VoiceResponse();
  
  if (!sessionId || !sessions.has(sessionId)) {
    console.log(`⚠️ Invalid or missing session: ${sessionId}`);
    twiml.say(
      { voice: 'Polly.Amy' },
      'I\'m sorry, your session has expired. Please call again.'
    );
    twiml.hangup();
    res.set('Content-Type', 'text/xml');
    return res.send(twiml.toString());
  }
  
  // Get session data
  const session = sessions.get(sessionId);
  
  // Get speech input from request
  const userSpeech = req.body.SpeechResult;
  
  if (userSpeech && userSpeech.trim()) {
    console.log(`👤 User said: "${userSpeech}"`);
    
    try {
      // Add user message to history
      session.messages.push({ role: 'user', content: userSpeech });
      
      // Store user message in Firebase with proper validation
      const userMessageData = {
        type: 'user',
        content: userSpeech
      };
      
      // Add call sids if available
      if (req.body.CallSid) {
        userMessageData.callSid = req.body.CallSid;
      }
      
      await storeConversation(sessionId, userMessageData);
      
      // Check for potential agent tasks
      analyzeConversation(sessionId, userSpeech);
      
      let responseText;
      
      // Use Assistant API if we have a thread ID, otherwise fall back to direct completion
      if (session.threadId) {
        try {
          console.log(`Using Assistant API with thread ${session.threadId}`);
          responseText = await getAssistantResponse(session.threadId, userSpeech);
          console.log(`🤖 Assistant API replied: "${responseText}"`);
          
          // Store AI response in Firebase
          await storeConversation(sessionId, {
            type: 'assistant',
            content: responseText,
            model: 'gpt-4o',
            assistant: true
          });
        } catch (assistantError) {
          // Log error but continue with fallback
          console.error('Error using Assistant API, falling back to direct completion:', assistantError);
          // Fall back to direct completion
          const completion = await openai.chat.completions.create({
            model: 'gpt-3.5-turbo',
            messages: [
              {
                role: 'system',
                content: SYSTEM_PROMPT
              },
              ...session.messages
            ],
            temperature: 0.7,
            max_tokens: 300
          });
          
          responseText = completion.choices[0].message.content;
          console.log(`🤖 Fallback AI replied: "${responseText}"`);
          
          // Store AI response in Firebase
          await storeConversation(sessionId, {
            type: 'assistant',
            content: responseText,
            model: 'gpt-3.5-turbo',
            tokensUsed: completion.usage?.total_tokens,
            fallback: true
          });
        }
      } else {
        // Direct GPT completion (old method)
        const completion = await openai.chat.completions.create({
          model: 'gpt-3.5-turbo',
          messages: [
            {
              role: 'system',
              content: SYSTEM_PROMPT
            },
            ...session.messages
          ],
          temperature: 0.7,
          max_tokens: 300
        });
        
        responseText = completion.choices[0].message.content;
        console.log(`🤖 AI replied: "${responseText}"`);
        
        // Store AI response in Firebase
        await storeConversation(sessionId, {
          type: 'assistant',
          content: responseText,
          model: 'gpt-3.5-turbo',
          tokensUsed: completion.usage?.total_tokens
        });
      }
      
      // Add assistant message to history
      session.messages.push({ role: 'assistant', content: responseText });
      
      // Say the response
      twiml.say({ voice: 'Polly.Amy' }, responseText);
      
      // Gather more speech input
      twiml.gather({
        input: 'speech',
        action: `/respond?session=${sessionId}`,
        method: 'POST',
        speechTimeout: 'auto',
        speechModel: 'phone_call',
        enhanced: true
      });
      
      // If no input, prompt again
      twiml.redirect({ method: 'POST' }, `/reprompt?session=${sessionId}`);
      
    } catch (error) {
      console.error('❌ Error generating response:', error);
      
      // Store error in Firebase
      await storeConversation(sessionId, {
        type: 'error',
        content: error.message,
        stack: error.stack
      });
      
      // Error fallback
      twiml.say(
        { voice: 'Polly.Amy' },
        'I\'m sorry, I encountered an error processing your request. Let\'s try again.'
      );
      
      // Gather more speech input
      twiml.gather({
        input: 'speech',
        action: `/respond?session=${sessionId}`,
        method: 'POST',
        speechTimeout: 'auto',
        speechModel: 'phone_call'
      });
      
      // If no input, prompt again
      twiml.redirect({ method: 'POST' }, `/reprompt?session=${sessionId}`);
    }
  } else {
    console.log('⚠️ No speech detected');
    
    // Store no speech event in Firebase
    await storeConversation(sessionId, {
      type: 'system',
      content: 'No speech detected'
    });
    
    // No speech detected
    twiml.say(
      { voice: 'Polly.Amy' },
      'I didn\'t hear you say anything. Could you please try again?'
    );
    
    // Gather more speech input
    twiml.gather({
      input: 'speech',
      action: `/respond?session=${sessionId}`,
      method: 'POST',
      speechTimeout: 'auto',
      speechModel: 'phone_call'
    });
    
    // If no input, prompt again
    twiml.redirect({ method: 'POST' }, `/reprompt?session=${sessionId}`);
  }
  
  // Send TwiML response
  res.set('Content-Type', 'text/xml');
  res.send(twiml.toString());
});

// Reprompt endpoint
app.post('/reprompt', (req, res) => {
  // Get session from query parameter
  const sessionId = req.query.session;
  
  // Create TwiML response
  const twiml = new twilio.twiml.VoiceResponse();
  
  if (!sessionId || !sessions.has(sessionId)) {
    console.log(`⚠️ Invalid or missing session: ${sessionId}`);
    twiml.say(
      { voice: 'Polly.Amy' },
      'I\'m sorry, your session has expired. Please call again.'
    );
    twiml.hangup();
    res.set('Content-Type', 'text/xml');
    return res.send(twiml.toString());
  }
  
  // Reprompt for input
  twiml.say(
    { voice: 'Polly.Amy' },
    'Are you still there? What would you like to know about our AI Agent Taskforce?'
  );
  
  // Gather more speech input
  twiml.gather({
    input: 'speech',
    action: `/respond?session=${sessionId}`,
    method: 'POST',
    speechTimeout: 'auto',
    speechModel: 'phone_call'
  });
  
  // If still no input, end the call
  twiml.say(
    { voice: 'Polly.Amy' },
    'I haven\'t heard from you. Goodbye for now!'
  );
  twiml.hangup();
  
  // Send TwiML response
  res.set('Content-Type', 'text/xml');
  res.send(twiml.toString());
});

// Status endpoint (for Twilio status callbacks)
app.post('/status', (req, res) => {
  console.log('📊 Call status update:', req.body.CallStatus);
  
  // If call completed or failed, clean up the session
  if (['completed', 'failed', 'busy', 'no-answer', 'canceled'].includes(req.body.CallStatus)) {
    // Find the session for this call
    for (const [sessionId, session] of sessions.entries()) {
      if (session.callSid === req.body.CallSid) {
        console.log(`🧹 Cleaning up session ${sessionId}`);
        
        // Mark the conversation as completed in Firebase
        completeConversation(sessionId);
        
        // Remove from active sessions
        sessions.delete(sessionId);
        break;
      }
    }
  }
  
  res.sendStatus(200);
});

// Start the server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Twilio Voice AI Agent running on port ${PORT}`);
  console.log(`📊 Health check: http://localhost:${PORT}/health`);
  console.log(`🌐 Server is configured for Cloud Run deployment`);
});
