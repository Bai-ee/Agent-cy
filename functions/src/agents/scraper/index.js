// Web Scraping Agent - Handles web scraping tasks
// Enhanced with crawl4ai-inspired features for AI integration
const BaseAgent = require("../../models/BaseAgent");
const puppeteer = require("puppeteer");
const admin = require("firebase-admin");
const db = admin.firestore();
const storage = require("../../services/storage");
const scheduler = require("../../utils/scheduler");
const config = require("../../config");
const cheerio = require("cheerio"); // For HTML parsing without browser
const axios = require("axios"); // For simple HTTP requests

class ScraperAgent extends BaseAgent {
  constructor(config = {}) {
    super("Web Scraper Agent", "scraper", config);
    this.defaultKeywords = config.defaultKeywords || [];
    this.defaultUrls = config.defaultUrls || [];
    
    // Enhanced configuration options
    this.userAgents = [
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/94.0.4606.81 Safari/537.36",
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/94.0.4606.81 Safari/537.36"
    ];
    
    this.maxRetries = config.maxRetries || 3;
    this.retryDelay = config.retryDelay || 1000;
    this.maxContentLength = config.maxContentLength || 12000; // For AI processing
    
    // Enhanced feature flags
    this.usePuppeteer = config.usePuppeteer !== false; // Default to true
    this.captureScreenshots = config.captureScreenshots !== false; // Default to true
    this.enableAIExtraction = config.enableAIExtraction !== false; // Default to true
    this.searchEnabled = config.searchEnabled !== false; // Default to true
  }

  /**
   * Start a scraping task
   * @param {Array<string>} urls - URLs to scrape
   * @param {Array<string>} keywords - Keywords to look for
   * @param {string} taskId - Associated task ID
   * @return {Promise<string>} - Job ID
   */
  /**
   * Create and start a web scraping HTTP callable function
   * This allows the Lead Agent to call the scraper via HTTP
   * @return {Function} - Firebase callable function
   */
  createCallableFunction() {
    const functions = require("firebase-functions");
    
    return functions.https.onCall(async (data, context) => {
      // Parse input data
      const { url, query, keywords = [], options = {} } = data;
      
      // Input validation
      if (!url && !query) {
        throw new Error("Either url or query must be provided");
      }
      
      let urlsToScrape = [];
      
      // If URL not provided but query is, search for relevant URLs
      if (!url && query && this.searchEnabled) {
        const searchUrls = await this.searchForUrls(query, options.maxSearchResults || 3);
        urlsToScrape = searchUrls;
      } else if (url) {
        // Use the provided URL
        urlsToScrape = [url];
      }
      
      // Start scraping process
      const jobId = await this.startScraping(urlsToScrape, keywords);
      
      return {
        success: true,
        jobId,
        message: `Scraping job started with ${urlsToScrape.length} URLs`,
        urls: urlsToScrape
      };
    });
  }
  
  /**
   * Start a scraping task
   * @param {Array<string>} urls - URLs to scrape
   * @param {Array<string>} keywords - Keywords to look for
   * @param {string} taskId - Associated task ID
   * @return {Promise<string>} - Job ID
   */
  async startScraping(urls, keywords, taskId = null) {
    try {
      // Generate a unique job ID
      const jobId = `scrape_${Date.now()}_${Math.floor(Math.random() * 1000)}`;

      // Store scraping job information
      await db.collection("scrapingJobs").doc(jobId).set({
        urls: urls || this.defaultUrls,
        keywords: keywords || this.defaultKeywords,
        taskId,
        status: "queued",
        agent: this.id,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      // Start the scraping immediately
      this.runScrapingJob(jobId).catch(console.error);

      await this.logActivity("Scraping job created", {jobId, urls, keywords});

      return jobId;
    } catch (error) {
      console.error("Error starting scraping job:", error);
      throw new Error(`Failed to start scraping job: ${error.message}`);
    }
  }

  /**
   * Run daily scraping based on configured sources
   * @return {Promise<Array<string>>} - List of job IDs created
   */
  async runDailyScraping() {
    try {
      // Get scraping sources from database
      const sourcesSnapshot = await db.collection("scrapingSources")
          .where("active", "==", true)
          .get();

      const jobIds = [];

      // Create a scraping job for each source
      for (const doc of sourcesSnapshot.docs) {
        const source = doc.data();
        const jobId = await this.startScraping(
            source.urls,
            source.keywords,
            `daily_${new Date().toISOString().split("T")[0]}_${doc.id}`,
        );
        jobIds.push(jobId);
      }

      await this.logActivity("Daily scraping initiated", {jobCount: jobIds.length});

      return jobIds;
    } catch (error) {
      console.error("Error running daily scraping:", error);
      throw new Error(`Failed to run daily scraping: ${error.message}`);
    }
  }

  /**
   * Execute a scraping job
   * @param {string} jobId - Job ID to execute
   * @return {Promise<void>}
   */
  async runScrapingJob(jobId) {
    try {
      // Update job status
      await db.collection("scrapingJobs").doc(jobId).update({
        status: "running",
        startedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      // Get job details
      const jobDoc = await db.collection("scrapingJobs").doc(jobId).get();
      const jobData = jobDoc.data();

      // Array to hold results
      const scrapedData = [];

      // Process each URL with optimal strategy
      for (const url of jobData.urls) {
        try {
          // Automatically select between Puppeteer and lightweight scraping
          const pageData = await this.scrapeUrl(url, jobData.keywords);
          scrapedData.push(pageData);
        } catch (pageError) {
          console.error(`Error scraping ${url}:`, pageError);
          scrapedData.push({
            url,
            success: false,
            error: pageError.message,
          });
        }
      }

      // Close browser
      await browser.close();

      // Save scraped data
      const scrapedDataId = `scrape_result_${jobId}`;
      await db.collection("scrapedData").doc(scrapedDataId).set({
        jobId,
        taskId: jobData.taskId,
        results: scrapedData,
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
        autoProcess: true, // Automatically process with copywriter
      });

      // Upload raw data to storage
      const rawDataPath = `scraping/${scrapedDataId}.json`;
      await storage.uploadFile(
          JSON.stringify(scrapedData, null, 2),
          rawDataPath,
          {contentType: "application/json"},
      );

      // Update job as completed
      await db.collection("scrapingJobs").doc(jobId).update({
        status: "completed",
        scrapedDataId,
        rawDataPath,
        endedAt: admin.firestore.FieldValue.serverTimestamp(),
        resultCount: scrapedData.length,
        successCount: scrapedData.filter((d) => d.success).length,
      });

      await this.logActivity("Scraping job completed", {
        jobId,
        scrapedDataId,
        resultCount: scrapedData.length,
      });
    } catch (error) {
      console.error("Error executing scraping job:", error);

      // Update job as failed
      await db.collection("scrapingJobs").doc(jobId).update({
        status: "failed",
        error: error.message,
        endedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      await this.logActivity("Scraping job failed", {jobId, error: error.message});
    }
  }

  /**
   * Scrape a specific page
   * @param {Browser} browser - Puppeteer browser instance
   * @param {string} url - URL to scrape
   * @param {Array<string>} keywords - Keywords to search for
   * @return {Promise<object>} - Page data
   */
  /**
   * Decide whether to use Puppeteer or lightweight scraping
   * @param {string} url - URL to scrape
   * @param {Array<string>} keywords - Keywords to look for
   * @param {Browser} browser - Optional Puppeteer browser instance
   * @return {Promise<object>} - Scraped data
   */
  async scrapeUrl(url, keywords, browser = null) {
    // For certain types of sites where JS isn't needed, use faster lightweight scraping
    if (!this.usePuppeteer || url.includes('wikipedia.org') || url.includes('britannica.com')) {
      return this.scrapeWithoutBrowser(url, keywords);
    }
    
    // Otherwise use Puppeteer for JS-heavy sites
    if (!browser) {
      browser = await puppeteer.launch({
        headless: true,
        args: ["--no-sandbox", "--disable-setuid-sandbox"]
      });
      
      const result = await this.scrapePage(browser, url, keywords);
      await browser.close();
      return result;
    }
    
    return this.scrapePage(browser, url, keywords);
  }
  
  /**
   * Scrape a specific page using Puppeteer
   * @param {Browser} browser - Puppeteer browser instance
   * @param {string} url - URL to scrape
   * @param {Array<string>} keywords - Keywords to search for
   * @return {Promise<object>} - Page data
   */
  async scrapePage(browser, url, keywords) {
    const page = await browser.newPage();

    try {
      // Set user agent
      await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36");

      // Navigate to the page
      await page.goto(url, {waitUntil: "networkidle2", timeout: 60000});

      // Extract metadata
      const title = await page.title();
      const description = await page.$eval("meta[name=\"description\"]",
          (el) => el.getAttribute("content")).catch(() => "");

      // Take a screenshot
      const screenshot = await page.screenshot({fullPage: false});

      // Get page content
      const content = await page.content();
      const textContent = await page.evaluate(() => document.body.innerText);

      // Extract main content using AI
      const mainContent = await this.extractMainContent(textContent, keywords);

      // Find keyword matches
      const keywordMatches = {};
      for (const keyword of keywords) {
        const regex = new RegExp(`\\b${keyword}\\b`, "gi");
        const matches = textContent.match(regex) || [];
        keywordMatches[keyword] = matches.length;
      }

      // Upload screenshot to storage
      const screenshotPath = `screenshots/${Date.now()}_${url.replace(/[^a-z0-9]/gi, "_")}.png`;
      const screenshotUrl = await storage.uploadFile(
          screenshot,
          screenshotPath,
          {contentType: "image/png"},
      );

      return {
        url,
        title,
        description,
        success: true,
        timestamp: new Date().toISOString(),
        mainContent,
        keywordMatches,
        totalKeywordMatches: Object.values(keywordMatches).reduce((a, b) => a + b, 0),
        textLength: textContent.length,
        screenshotUrl,
      };
    } catch (error) {
      console.error(`Error scraping ${url}:`, error);
      return {
        url,
        success: false,
        error: error.message,
        timestamp: new Date().toISOString(),
      };
    } finally {
      await page.close();
    }
  }

  /**
   * Search for relevant URLs based on a query
   * @param {string} query - Search query
   * @param {number} maxResults - Maximum number of results to return
   * @return {Promise<Array<string>>} - Array of URLs
   */
  async searchForUrls(query, maxResults = 3) {
    try {
      await this.logActivity("Searching for URLs", {query, maxResults});
      
      // For common topics, use predefined reliable sources
      const queryLower = query.toLowerCase();
      const predefinedUrls = [];
      
      // Add topic-specific URLs based on query analysis
      if (queryLower.includes('weather')) {
        predefinedUrls.push('https://weather.com/');
      } else if (queryLower.includes('news')) {
        predefinedUrls.push('https://news.google.com/');
      } else if (queryLower.match(/who is|what is|when did|where is/i)) {
        // Extract main topic for Wikipedia
        const topic = query.replace(/who is|what is|when did|where is/i, '').trim();
        if (topic) {
          predefinedUrls.push(`https://en.wikipedia.org/wiki/${encodeURIComponent(topic)}`);
        }
      }
      
      if (predefinedUrls.length > 0) {
        return predefinedUrls.slice(0, maxResults);
      }
      
      // In a production environment, integrate with a search API here
      // For now, use a few fallback reliable sources based on the query
      const fallbackSources = [
        `https://en.wikipedia.org/wiki/Special:Search?search=${encodeURIComponent(query)}`,
        `https://www.britannica.com/search?query=${encodeURIComponent(query)}`
      ];
      
      return fallbackSources.slice(0, maxResults);
    } catch (error) {
      console.error("Error searching for URLs:", error);
      return [];
    }
  }
  
  /**
   * Lightweight scraping method using axios and cheerio
   * Faster than puppeteer for simple pages that don't require JS rendering
   * @param {string} url - URL to scrape
   * @param {Array<string>} keywords - Keywords to look for
   * @return {Promise<object>} - Scraped data
   */
  async scrapeWithoutBrowser(url, keywords) {
    try {
      // Get a random user agent
      const userAgent = this.userAgents[Math.floor(Math.random() * this.userAgents.length)];
      
      // Set up retry mechanism
      let retries = 0;
      let response;
      
      while (retries < this.maxRetries) {
        try {
          // Fetch content with proper headers
          response = await axios.get(url, {
            headers: {
              'User-Agent': userAgent,
              'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
              'Accept-Language': 'en-US,en;q=0.5',
              'Cache-Control': 'no-cache',
              'Pragma': 'no-cache'
            },
            timeout: 15000
          });
          
          break; // Success, exit retry loop
        } catch (error) {
          retries++;
          console.warn(`Retry ${retries}/${this.maxRetries} for ${url}: ${error.message}`);
          
          if (retries >= this.maxRetries) {
            throw error;
          }
          
          // Exponential backoff
          await new Promise(resolve => setTimeout(resolve, this.retryDelay * Math.pow(2, retries)));
        }
      }
      
      const html = response.data;
      
      // Use cheerio to parse HTML
      const $ = cheerio.load(html);
      
      // Extract metadata
      const title = $('title').text().trim();
      const description = $('meta[name="description"]').attr('content') || 
                         $('meta[property="og:description"]').attr('content') || '';
      
      // Remove unwanted elements
      $('script, style, nav, footer, iframe, noscript').remove();
      
      // Extract main content
      let mainElement;
      
      // Try finding main content containers first
      mainElement = $('main, article, #content, .content, .post, .article');
      
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
      
      // Get text content
      const textContent = mainElement.text().trim().replace(/\s+/g, ' ');
      
      // Extract headings for structure
      const headings = [];
      mainElement.find('h1, h2, h3, h4, h5, h6').each((i, el) => {
        const level = parseInt(el.name.substring(1));
        const content = $(el).text().trim();
        if (content) {
          headings.push({ level, content });
        }
      });
      
      // Extract links
      const links = [];
      mainElement.find('a[href]').each((i, el) => {
        const href = $(el).attr('href');
        const text = $(el).text().trim();
        if (href && text && !href.startsWith('#')) {
          links.push({ href, text });
        }
      });
      
      // Find keyword matches
      const keywordMatches = {};
      for (const keyword of keywords) {
        const regex = new RegExp(`\\b${keyword}\\b`, "gi");
        const matches = textContent.match(regex) || [];
        keywordMatches[keyword] = matches.length;
      }
      
      // Extract main content using AI if enabled
      let mainContent = textContent;
      if (this.enableAIExtraction) {
        mainContent = await this.extractMainContent(textContent, keywords);
      }
      
      return {
        url,
        title,
        description,
        success: true,
        timestamp: new Date().toISOString(),
        mainContent,
        keywordMatches,
        totalKeywordMatches: Object.values(keywordMatches).reduce((a, b) => a + b, 0),
        textLength: textContent.length,
        headings,
        links: links.slice(0, 20), // Limit to first 20 links
        method: 'lightweight'
      };
    } catch (error) {
      console.error(`Error lightweight scraping ${url}:`, error);
      return {
        url,
        success: false,
        error: error.message,
        timestamp: new Date().toISOString(),
        method: 'lightweight'
      };
    }
  }
  
  /**
   * Extract the main content from page text using AI
   * @param {string} fullText - Full page text
   * @param {Array<string>} keywords - Keywords to focus on
   * @return {Promise<string>} - Extracted main content
   */
  async extractMainContent(fullText, keywords) {
    // Truncate text if too long
    const truncatedText = fullText.length > this.maxContentLength ?
      fullText.substring(0, this.maxContentLength) + "..." :
      fullText;

    // Use OpenAI for better extraction if available
    if (process.env.OPENAI_API_KEY) {
      try {
        const { OpenAI } = require("openai");
        const openai = new OpenAI();
        
        const systemPrompt = `You are an expert content analyst. Extract the most relevant information from web content.`;
        
        const userPrompt = `
        Extract the most important and relevant information from this web page text. 
        Focus especially on information related to these keywords: ${keywords.join(", ")}.
        
        Page text:
        ${truncatedText}
        
        Extract only the main meaningful content. Ignore navigation menus, ads, footers, headers, and other boilerplate elements.
        Format the extracted content in a clean, readable way. Include all relevant facts and details.
        Structure your response with headings and bullet points where appropriate.
        `;
        
        const completion = await openai.chat.completions.create({
          model: "gpt-4o",
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt }
          ],
          temperature: 0.3,
          max_tokens: 1500
        });
        
        return completion.choices[0].message.content;
      } catch (error) {
        console.error("Error using OpenAI for content extraction:", error);
        // Fall back to built-in extraction method
      }
    }

    // Fallback to the original method
    const prompt = `
    Extract the most important and relevant information from this web page text. 
    Focus especially on information related to these keywords: ${keywords.join(", ")}.
    
    Page text:
    ${truncatedText}
    
    Extract only the main meaningful content. Ignore navigation menus, ads, footers, headers, and other boilerplate elements.
    Format the extracted content in a clean, readable way.
    `;

    const mainContent = await this.generateText(prompt, {
      temperature: 0.3,
      maxTokens: 1000,
    });

    return mainContent;
  }
  
  /**
   * Create a tool definition for the OpenAI Assistant API
   * This allows the Lead Agent to use the Web Scraper via the Assistant API
   * @return {Object} - Tool definition for OpenAI Assistant
   */
  getAssistantToolDefinition() {
    return {
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
          },
          required: []
        }
      }
    };
  }
}

// Create a singleton instance
const scraperAgent = new ScraperAgent();

module.exports = scraperAgent;
