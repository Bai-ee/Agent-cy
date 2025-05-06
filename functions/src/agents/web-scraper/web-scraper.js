// Web Scraper Agent for AI Taskforce
// Inspired by crawl4ai (https://github.com/unclecode/crawl4ai)
// This agent handles web scraping tasks and feeds data to other agents

import * as functions from 'firebase-functions';
import { getFirestore } from 'firebase-admin/firestore';
import axios from 'axios';
import { load } from 'cheerio';
import { OpenAI } from 'openai';

// Configure axios default timeout
axios.defaults.timeout = 15000;

// Initialize OpenAI client
const openai = new OpenAI();

/**
 * Web Scraper Agent
 * Fetches content from provided URLs or search queries
 * and prepares it for use by other agents
 */
export const webScraper = functions.https.onCall(async (data, context) => {
  const { url, query, options = {} } = data;
  const db = getFirestore();
  
  try {
    // Validate input
    if (!url && !query) {
      throw new Error('Either url or query must be provided');
    }
    
    // Log the scraping request
    functions.logger.info(`Web Scraper agent activated for ${url || query}`);
    
    // If no direct URL provided, perform search (mock implementation for now)
    const targetUrl = url || await searchForUrl(query);
    
    // Fetch HTML content with proper headers
    const scrapedContent = await scrapeUrl(targetUrl, options);
    
    // Parse and extract meaningful content
    const extractedData = await extractContent(scrapedContent.html, targetUrl);
    
    // Use AI to summarize and organize the content
    const aiProcessedData = await processWithAI(extractedData, targetUrl, options);
    
    // Store the results in Firestore
    const scrapeId = `scrape_${Date.now()}`;
    const scrapeResult = {
      id: scrapeId,
      url: targetUrl,
      query: query || null,
      timestamp: Date.now(),
      raw: {
        title: extractedData.title,
        description: extractedData.description,
        textLength: extractedData.text.length,
      },
      processed: aiProcessedData,
      status: 'completed'
    };
    
    await db.collection('scrapes').doc(scrapeId).set(scrapeResult);
    
    // Trigger notification for the next agent in the workflow (Copywriter)
    await notifyNextAgent(scrapeResult);
    
    return { 
      success: true, 
      id: scrapeId,
      data: {
        url: targetUrl,
        title: extractedData.title,
        summary: aiProcessedData.summary,
        keyPoints: aiProcessedData.keyPoints,
      }
    };
    
  } catch (error) {
    functions.logger.error('Web Scraper agent error:', error);
    
    // Store error information in Firestore for tracking
    const errorId = `scrape_error_${Date.now()}`;
    await db.collection('scrape_errors').doc(errorId).set({
      url: url || null,
      query: query || null,
      error: error.message,
      stack: error.stack,
      timestamp: Date.now()
    });
    
    return { 
      success: false, 
      error: error.message,
      errorId
    };
  }
});

/**
 * Search for a URL based on query (mock implementation)
 * In production, this would use a search API
 */
async function searchForUrl(query) {
  // Mock implementation - would use Google Search API or similar in production
  functions.logger.info(`Searching for URL for query: ${query}`);
  
  // For common questions, return known reliable sources
  const queryLower = query.toLowerCase();
  if (queryLower.includes('weather')) {
    return 'https://weather.com/';
  } else if (queryLower.includes('news')) {
    return 'https://news.google.com/';
  } else if (queryLower.includes('wikipedia') || queryLower.includes('what is')) {
    // Extract main topic and create Wikipedia URL
    const topic = query.replace(/what is|wikipedia|tell me about|who is/gi, '').trim();
    return `https://en.wikipedia.org/wiki/${encodeURIComponent(topic)}`;
  }
  
  // Fallback for development
  return 'https://en.wikipedia.org/wiki/Web_scraping';
}

/**
 * Scrape a URL with proper error handling and retries
 */
async function scrapeUrl(url, options = {}) {
  functions.logger.info(`Scraping URL: ${url}`);
  
  const maxRetries = options.maxRetries || 3;
  let retries = 0;
  
  while (retries < maxRetries) {
    try {
      // Fetch content with proper headers to avoid detection
      const response = await axios.get(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; AITaskforceScraper/1.0)',
          'Accept': 'text/html,application/xhtml+xml',
          'Accept-Language': 'en-US,en;q=0.9',
          'Cache-Control': 'no-cache',
          'Pragma': 'no-cache'
        }
      });
      
      // Check if we got a successful response
      if (response.status !== 200) {
        throw new Error(`HTTP Error: ${response.status}`);
      }
      
      return {
        html: response.data,
        url: response.request.res.responseUrl || url, // Handle redirects
        status: response.status
      };
      
    } catch (error) {
      retries++;
      functions.logger.warn(`Scraping attempt ${retries} failed for ${url}: ${error.message}`);
      
      if (retries >= maxRetries) {
        throw new Error(`Failed to scrape URL after ${maxRetries} attempts: ${error.message}`);
      }
      
      // Exponential backoff before retry
      await new Promise(resolve => setTimeout(resolve, 1000 * Math.pow(2, retries)));
    }
  }
}

/**
 * Extract useful content from HTML
 */
async function extractContent(html, url) {
  functions.logger.info(`Extracting content from ${url}`);
  
  // Use cheerio to parse HTML (jQuery-like for server)
  const $ = load(html);
  
  // Remove unwanted elements that typically contain noise
  $('script, style, nav, footer, iframe, noscript, svg, [role=banner], [role=navigation]').remove();
  
  // Extract basic metadata
  const title = $('title').text().trim() || $('h1').first().text().trim() || '';
  const description = $('meta[name="description"]').attr('content') || 
                     $('meta[property="og:description"]').attr('content') || '';
  
  // Extract main content based on common patterns
  // Try finding main content containers first
  let mainElement = $('main, article, #content, .content, .post, .article');
  
  if (mainElement.length === 0) {
    // Fallback to largest text container
    let maxTextLength = 0;
    let maxTextElement = $('body');
    
    $('div, section').each((i, el) => {
      const textLength = $(el).text().trim().length;
      if (textLength > maxTextLength) {
        maxTextLength = textLength;
        maxTextElement = $(el);
      }
    });
    
    mainElement = maxTextElement;
  }
  
  // Extract text content, headers and important elements
  const text = mainElement.text().trim().replace(/\\s+/g, ' ');
  
  // Extract headings for structure
  const headings = [];
  mainElement.find('h1, h2, h3, h4, h5, h6').each((i, el) => {
    const level = parseInt(el.name.substring(1));
    const content = $(el).text().trim();
    if (content) {
      headings.push({ level, content });
    }
  });
  
  // Extract links from main content
  const links = [];
  mainElement.find('a[href]').each((i, el) => {
    const href = $(el).attr('href');
    const text = $(el).text().trim();
    if (href && text && !href.startsWith('#')) {
      links.push({ href, text });
    }
  });
  
  return {
    title,
    description,
    text,
    headings,
    links,
    url
  };
}

/**
 * Process extracted content with AI to make it usable
 */
async function processWithAI(extractedData, url, options = {}) {
  functions.logger.info(`Processing content from ${url} with AI`);
  
  // Truncate text if it's too long for the AI context window
  const maxLength = options.maxLength || 9000;
  const text = extractedData.text.substring(0, maxLength);
  
  // Prepare content for AI processing
  const context = `
URL: ${url}
TITLE: ${extractedData.title}
DESCRIPTION: ${extractedData.description}

CONTENT:
${text}

HEADINGS:
${extractedData.headings.map(h => `${'-'.repeat(h.level)} ${h.content}`).join('\n')}
`;

  try {
    // Use OpenAI to summarize and structure the content
    const completion = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        {
          role: "system",
          content: `You are an expert content analyst and summarizer for the AI Agent Taskforce.
Extract the most important and relevant information from web content.
Format your response as structured JSON with the following sections:
1. summary - A concise summary of the main content (200-300 words)
2. keyPoints - An array of the 5-7 most important points
3. topics - An array of main topics covered
4. sentiment - Overall sentiment (positive, negative, neutral, mixed)
5. entities - Key people, organizations, products mentioned`
        },
        {
          role: "user",
          content: context
        }
      ],
      response_format: { type: "json_object" }
    });
    
    // Parse the JSON response
    const aiResponse = JSON.parse(completion.choices[0].message.content);
    
    return {
      ...aiResponse,
      processedAt: Date.now(),
      tokens: {
        prompt: completion.usage.prompt_tokens,
        completion: completion.usage.completion_tokens,
        total: completion.usage.total_tokens
      }
    };
    
  } catch (error) {
    functions.logger.error(`AI processing error: ${error.message}`);
    
    // Provide a basic fallback if AI processing fails
    return {
      summary: `Failed to generate AI summary. Original title: ${extractedData.title}. Description: ${extractedData.description}`,
      keyPoints: [],
      topics: [],
      sentiment: "unknown",
      entities: [],
      error: error.message
    };
  }
}

/**
 * Notify the next agent in the workflow (e.g., Copywriter)
 */
async function notifyNextAgent(scrapeResult) {
  functions.logger.info(`Notifying next agent about scrape ${scrapeResult.id}`);
  
  try {
    // Add to a queue for the next agent to pick up
    const db = getFirestore();
    await db.collection('agent_tasks').add({
      type: 'copywriter',
      source: 'web_scraper',
      status: 'pending',
      data: {
        scrapeId: scrapeResult.id,
        url: scrapeResult.url,
        title: scrapeResult.raw.title,
      },
      createdAt: Date.now()
    });
    
    return true;
  } catch (error) {
    functions.logger.error(`Failed to notify next agent: ${error.message}`);
    return false;
  }
}

// Export the web scraper function
export default webScraper;
