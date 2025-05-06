// Utility functions for OpenAI Assistants API integration
import { OpenAI } from 'openai';

// Initialize OpenAI client
let openaiClient = null;

// Initialize mapping between phone numbers and thread IDs
const phoneToThreadMap = new Map();

// Assistant ID cache
let assistantId = null;

/**
 * Initialize the OpenAI client and create/retrieve the assistant
 * @param {string} apiKey - OpenAI API key
 * @returns {Object} - OpenAI client and assistant ID
 */
export async function initializeAssistant(apiKey) {
  try {
    // Initialize OpenAI client
    openaiClient = new OpenAI({ apiKey });
    console.log('🔄 OpenAI client initialized for Assistants API');
    console.log(`🔑 Using API key starting with: ${apiKey.substring(0, 10)}...`);

    // Check if we already have an assistant ID stored
    if (!assistantId) {
      // Create or retrieve the assistant
      const assistantName = "Lead Agent";
      
      console.log(`🔍 Looking for existing assistant: ${assistantName}`);
      // First check if the assistant already exists
      const assistants = await openaiClient.beta.assistants.list({
        limit: 100,
      });
      
      console.log(`📋 Found ${assistants.data.length} assistants in the account`);
      assistants.data.forEach(a => {
        console.log(`- Assistant: ${a.name} (${a.id})`);
      });
      
      const existingAssistant = assistants.data.find(a => a.name === assistantName);
      
      if (existingAssistant) {
        assistantId = existingAssistant.id;
        console.log(`✅ Found existing assistant: ${assistantName} (${assistantId})`);
        console.log(`📝 Assistant tools:`, JSON.stringify(existingAssistant.tools, null, 2));
      } else {
        console.log(`🆕 Creating new assistant: ${assistantName}`);
        // Define tool JSON explicitly for logging
        const tools = [
          {
            type: "function",
            function: {
              name: "getWeather",
              description: "Get the current weather forecast for a specific location and date",
              parameters: {
                type: "object",
                properties: {
                  location: {
                    type: "string",
                    description: "The city and state or country, e.g. San Francisco, CA or Paris, France"
                  },
                  date: {
                    type: "string",
                    description: "The date for the forecast, e.g. 'today', 'tomorrow', or a specific date like '2023-07-15'. Optional, defaults to today."
                  }
                },
                required: ["location"]
              }
            }
          },
          {
            type: "function",
            function: {
              name: "searchWeb",
              description: "Search for information on the web and extract relevant content from web pages",
              parameters: {
                type: "object",
                properties: {
                  url: {
                    type: "string",
                    description: "Specific URL to scrape for information"
                  },
                  query: {
                    type: "string",
                    description: "Search query if no specific URL is provided"
                  },
                  keywords: {
                    type: "array",
                    items: {
                      type: "string"
                    },
                    description: "Keywords to focus on when extracting content"
                  }
                }
              }
            }
          }
        ];
        
        console.log(`🔧 Registering assistant with tools:`, JSON.stringify(tools, null, 2));
        
        // Create a new assistant
        const assistant = await openaiClient.beta.assistants.create({
          name: assistantName,
          instructions: `You are the Lead Agent for AI Taskforce, a specialized system with 6 agents:
- Lead Agent (you): Handle scheduled calls and coordinate other agents
- Web Scraper: Gather information from web sources
- Copywriter: Create content based on information
- Graphic Designer: Generate images and visual assets
- Social Media Manager: Post content to social platforms
- Project Manager: Handle approvals and coordination

Respond helpfully and professionally to voice queries. 
Keep responses concise as they will be spoken aloud.
Spell out numbers (say 'twenty' not '20').
Use contractions and casual language to sound natural when spoken.

YOU HAVE ACCESS TO TOOLS INCLUDING A WEATHER TOOL. WHEN ASKED ABOUT WEATHER, USE THE getWeather TOOL.`,
          tools: tools,
          model: "gpt-4o"
        });
        
        console.log(`🚀 Assistant created with ID: ${assistant.id}`);
        console.log(`🔧 Assistant tools confirmed:`, JSON.stringify(assistant.tools, null, 2));
        
        assistantId = assistant.id;
        console.log(`Created new assistant: ${assistantName} (${assistantId})`);
      }
    }
    
    return { openaiClient, assistantId };
  } catch (error) {
    console.error('Error initializing OpenAI Assistant:', error);
    throw error;
  }
}

/**
 * Ensure a thread exists for the given phone number
 * @param {string} phoneNumber - The caller's phone number
 * @returns {string} - Thread ID
 */
export async function ensureThreadForPhoneNumber(phoneNumber) {
  try {
    if (!openaiClient) {
      throw new Error('OpenAI client not initialized');
    }
    
    // Check if we already have a thread for this phone number
    if (phoneToThreadMap.has(phoneNumber)) {
      return phoneToThreadMap.get(phoneNumber);
    }
    
    // Create a new thread
    const thread = await openaiClient.beta.threads.create();
    const threadId = thread.id;
    
    // Store the mapping
    phoneToThreadMap.set(phoneNumber, threadId);
    console.log(`Created new thread (${threadId}) for phone number: ${phoneNumber}`);
    
    return threadId;
  } catch (error) {
    console.error('Error ensuring thread for phone number:', error);
    throw error;
  }
}

/**
 * Add a user message to a thread and get the assistant response
 * @param {string} threadId - Thread ID
 * @param {string} userMessage - User's message
 * @returns {string} - Assistant's response
 */
export async function getAssistantResponse(threadId, userMessage) {
  try {
    console.log(`
🤖 ASSISTANT API REQUEST START 🤖
---------------------------------`);
    console.log(`🧵 Thread ID: ${threadId}`);
    console.log(`🗣️ User Message: "${userMessage}"`);
    
    if (!openaiClient || !assistantId) {
      console.error('❌ ERROR: OpenAI client or assistant ID not initialized');
      throw new Error('OpenAI client or assistant ID not initialized');
    }
    
    console.log(`👤 Adding user message to thread ${threadId}`);
    // Add the user message to the thread
    const createdMessage = await openaiClient.beta.threads.messages.create(
      threadId,
      {
        role: "user",
        content: userMessage
      }
    );
    console.log(`✅ Message added successfully, ID: ${createdMessage.id}`);
    
    console.log(`🚀 Creating run with assistant ${assistantId}`);
    // Create a run with the assistant
    const run = await openaiClient.beta.threads.runs.create(
      threadId,
      { 
        assistant_id: assistantId
      }
    );
    console.log(`✅ Run created successfully, ID: ${run.id}`);
    
    console.log(`⏳ Polling for run completion...`);
    // Poll until the run completes
    let runStatus = await pollRunStatus(threadId, run.id);
    console.log(`📊 Run status: ${runStatus.status}`);
    
    // Check if tool calls are required
    if (runStatus.status === 'requires_action') {
      console.log(`🔧 Tool calls required!`);
      // Process tool calls
      const toolCalls = runStatus.required_action.submit_tool_outputs.tool_calls;
      console.log(`📋 Number of tool calls: ${toolCalls.length}`);
      
      console.log(`Tool calls details: ${JSON.stringify(toolCalls, null, 2)}`);
      
      const toolOutputs = [];
      
      for (const toolCall of toolCalls) {
        console.log(`🔨 Processing tool: ${toolCall.function.name}`);
        console.log(`📝 Tool arguments: ${toolCall.function.arguments}`);
        
        if (toolCall.function.name === 'getWeather') {
          console.log(`🌤️ Executing getWeather tool...`);
          const args = JSON.parse(toolCall.function.arguments);
          console.log(`🌍 Location: ${args.location}, Date: ${args.date}`);
          
          const weatherOutput = await getWeather(args);
          console.log(`🌡️ Weather output: "${weatherOutput}"`);
          
          toolOutputs.push({
            tool_call_id: toolCall.id,
            output: weatherOutput
          });
          console.log(`✅ Added tool output for tool call ${toolCall.id}`);
        } else if (toolCall.function.name === 'searchWeb') {
          console.log(`🔍 Executing searchWeb tool...`);
          const args = JSON.parse(toolCall.function.arguments);
          console.log(`🌐 URL: ${args.url}, Query: ${args.query}, Keywords: ${args.keywords}`);
          
          const webOutput = await searchWeb(args);
          console.log(`📊 Web output: "${webOutput}"`);
          
          toolOutputs.push({
            tool_call_id: toolCall.id,
            output: webOutput
          });
          console.log(`✅ Added tool output for tool call ${toolCall.id}`);
        } else {
          console.warn(`⚠️ Unknown tool called: ${toolCall.function.name}`);
        }
        // Add more tool handling cases here as needed
      }
      
      if (toolOutputs.length > 0) {
        console.log(`📤 Submitting ${toolOutputs.length} tool outputs back to the Assistant...`);
        // Submit tool outputs
        await openaiClient.beta.threads.runs.submitToolOutputs(
          threadId,
          run.id,
          {
            tool_outputs: toolOutputs
          }
        );
        console.log(`✅ Tool outputs submitted successfully`);
        
        // Poll again for final status
        console.log(`⏳ Polling again for final status...`);
        runStatus = await pollRunStatus(threadId, run.id);
        console.log(`📊 Final run status: ${runStatus.status}`);
      } else {
        console.warn(`⚠️ No tool outputs were created despite requiring action!`);
      }
    }
    
    console.log(`📥 Getting messages from thread...`);
    // Get the last message from the assistant
    const messages = await openaiClient.beta.threads.messages.list(
      threadId
    );
    
    console.log(`📋 Retrieved ${messages.data.length} messages from thread`);
    messages.data.forEach((msg, index) => {
      console.log(`Message ${index + 1}: Role=${msg.role}, Content=${JSON.stringify(msg.content).substring(0, 100)}...`);
    });
    
    const lastMessage = messages.data.find(m => m.role === "assistant");
    if (!lastMessage) {
      console.error(`❌ ERROR: No assistant message found in the thread!`);
      throw new Error('No assistant message found');
    }
    
    console.log(`📝 Found last assistant message: ${lastMessage.id}`);
    console.log(`📄 Content type: ${lastMessage.content[0].type}`);
    
    // Extract text content from the message
    const responseText = lastMessage.content[0].text.value;
    console.log(`🗣️ Final response: "${responseText.substring(0, 100)}..."`);
    console.log(`
🤖 ASSISTANT API REQUEST COMPLETE 🤖
-------------------------------------`);
    return responseText;
  } catch (error) {
    console.error('Error getting assistant response:', error);
    throw error;
  }
}

/**
 * Poll the run status until it completes or requires action
 * @param {string} threadId - Thread ID
 * @param {string} runId - Run ID
 * @returns {Object} - Run status
 */
async function pollRunStatus(threadId, runId) {
  const terminalStates = ['completed', 'failed', 'cancelled', 'requires_action', 'expired'];
  let runStatus;
  let iterations = 0;
  const maxIterations = 60; // About 30 seconds max polling time
  
  console.log(`🔄 Starting polling for run ${runId} in thread ${threadId}`);
  
  while (iterations < maxIterations) {
    iterations++;
    
    try {
      runStatus = await openaiClient.beta.threads.runs.retrieve(
        threadId,
        runId
      );
      
      console.log(`📊 Run status: ${runStatus.status} (poll iteration ${iterations})`);
      
      if (terminalStates.includes(runStatus.status)) {
        console.log(`✅ Reached terminal state: ${runStatus.status}`);
        
        // If failed, log the detailed error
        if (runStatus.status === 'failed') {
          console.error(`❌ Run failed with error:`, JSON.stringify(runStatus.last_error, null, 2));
        }
        
        // If requires action, log the required action details
        if (runStatus.status === 'requires_action') {
          console.log(`🔧 Run requires action:`, JSON.stringify(runStatus.required_action, null, 2));
          console.log(`🔍 Available tools:`, runStatus.required_action.submit_tool_outputs.tool_calls.map(t => t.function.name));
        }
        
        break;
      }
      
      // Log any progress or step details
      if (runStatus.status === 'in_progress' && runStatus.step_details) {
        console.log(`⏳ Step details:`, JSON.stringify(runStatus.step_details, null, 2));
      }
      
    } catch (error) {
      console.error(`❌ Error polling run status (attempt ${iterations}):`, error);
      // Continue polling despite errors
    }
    
    // Wait before polling again (500ms)
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  
  if (iterations >= maxIterations) {
    console.warn(`⚠️ Reached maximum polling iterations (${maxIterations}) without reaching a terminal state.`);
  }
  
  return runStatus;
}

/**
 * Get weather forecast for a location and date (mock implementation)
 * @param {Object} args - Function arguments
 * @param {string} args.location - Location
 * @param {string} args.date - Date
 * @returns {string} - Weather forecast
 */
async function getWeather({ location, date }) {
  console.log(`
🌤️ WEATHER TOOL CALLED 🌤️
-------------------`);
  console.log(`📍 Location: ${location}`);
  console.log(`📅 Date: ${date || 'today'}`);
  console.log(`-------------------`);

  // Mock implementation - in production, you would call a real weather API
  const temperatures = {
    'new york': 68,
    'san francisco': 62,
    'chicago': 72,
    'los angeles': 75,
    'miami': 85,
    'seattle': 58,
    'austin': 82,
    'boston': 66,
    'denver': 70,
  };

  const conditions = {
    'new york': 'Partly Cloudy',
    'san francisco': 'Foggy',
    'chicago': 'Sunny',
    'los angeles': 'Sunny',
    'miami': 'Thunderstorms',
    'seattle': 'Rainy',
    'austin': 'Clear',
    'boston': 'Cloudy',
    'denver': 'Sunny',
  };

  // Normalize location to lowercase for matching
  const normalizedLocation = location.toLowerCase();

  // Get temperature and conditions, with defaults if not found
  const temperature = temperatures[normalizedLocation] || 70;
  const condition = conditions[normalizedLocation] || 'Clear';

  // Format response
  const response = {
    location: location,
    date: date || 'today',
    temperature: temperature,
    condition: condition,
    forecast: `${temperature}°F and ${condition}`,
  };

  console.log(`📅 Formatted date text: "${date}"`);
  
  const responseText = `${date} in ${location} it will be ${temperature}°F and ${condition}.`;
  console.log(`💬 Final weather response: "${responseText}"`);
  console.log(`🌤️ WEATHER TOOL COMPLETE 🌤️
-------------------------`);
  
  return responseText;
}

// Implementation of the searchWeb tool using Firebase Functions
export async function searchWeb({ url, query, keywords = [] }) {
  console.log(`
🔍 WEB SCRAPER TOOL CALLED 🔍
---------------------------`);
  console.log(`🌐 URL: ${url || 'Not provided'}`);
  console.log(`🔎 Query: ${query || 'Not provided'}`);
  console.log(`🏷️ Keywords: ${keywords ? keywords.join(', ') : 'None provided'}`);
  console.log(`---------------------------`);
  
  try {
    // Validate input
    if (!url && !query) {
      throw new Error('Either url or query must be provided');
    }
    
    // For this implementation, we'll use a simplified mock version
    // In production, this would call the Firebase function
    
    // Mock result for testing
    let result;
    
    if (url) {
      console.log(`📄 Scraping specific URL: ${url}`);
      
      result = {
        success: true,
        url: url,
        title: `Information about ${url.split('/').pop() || 'the requested topic'}`,
        summary: `This is information extracted from ${url}. The page contains details about ${url.split('/').pop() || 'the requested topic'}.`,
        keyPoints: [
          `Key point 1 about ${url.split('/').pop() || 'the topic'}`,
          `Key point 2 about ${url.split('/').pop() || 'the topic'}`,
          `Key point 3 about ${url.split('/').pop() || 'the topic'}`
        ]
      };
    } else if (query) {
      console.log(`🔎 Searching for: ${query}`);
      
      result = {
        success: true,
        query: query,
        results: [
          {
            title: `Information about ${query}`,
            url: `https://example.com/search?q=${encodeURIComponent(query)}`,
            snippet: `This is information about ${query}. In production, this would contain actual content from web searches.`
          }
        ],
        summary: `Here is information about ${query}. This is a comprehensive overview that would be generated from actual web content in production.`
      };
    }
    
    console.log(`📊 Result: ${JSON.stringify(result).substring(0, 150)}...`);
    console.log(`---------------------------\n`);
    
    return result;
    
  } catch (error) {
    console.error(`❌ Web scraper error: ${error.message}`);
    console.log(`---------------------------\n`);
    
    return {
      success: false,
      error: error.message
    };
  }
}
