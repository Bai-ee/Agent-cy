# Agent-cy

AI-powered voice agent system with web scraping capabilities, built with Node.js, Express, Twilio, and OpenAI Assistants API.

## System Architecture

The AI agent taskforce framework consists of 6 specialized agents working together:

1. **Lead Agent**: Handles scheduled calls and coordinates other agents
2. **Web Scraper**: Gathers information from web sources
3. **Copywriter**: Creates content based on scraped information
4. **Graphic Designer**: Generates images and visual assets
5. **Social Media Manager**: Posts content to social platforms
6. **Project Manager**: Handles approvals and coordination

The system is built using Firebase (Firestore, Functions, Storage) with integrations for OpenAI, Twilio, and social media APIs.

## Setup Instructions

1. Clone this repository
2. Copy `.env.sample` to `.env` and fill in your API keys
3. Install dependencies: `npm install`
4. Run the application: `npm start`

## Environment Variables

Create a `.env` file with the following:

```
# Twilio Configuration
TWILIO_SID=your_twilio_sid_here
TWILIO_TOKEN=your_twilio_auth_token_here
TWILIO_PHONE=your_twilio_phone_number_here

# OpenAI Configuration
OPENAI_API_KEY=your_openai_api_key_here
```

## Deployment

The application is deployed to Google Cloud Run:

```bash
gcloud run deploy voice-agent-scraper --source . --allow-unauthenticated --region us-central1 --update-env-vars OPENAI_API_KEY=$OPENAI_API_KEY,TWILIO_SID=$TWILIO_SID,TWILIO_TOKEN=$TWILIO_TOKEN,TWILIO_PHONE=$TWILIO_PHONE
```

Current deployment: https://voice-agent-scraper-997372296758.us-central1.run.app

## Maintaining Your Working Codebase

### Important: Local Development vs. GitHub Repository

This project maintains two separate versions:

1. **Working Codebase** - Your original directory at `/Users/bryanballi/Master_Agents/agent-taskforce` contains the complete project with all credentials and functionality

2. **GitHub Repository** - A sanitized version at https://github.com/Bai-ee/Agent-cy with sensitive information removed

### Making Changes

Follow these steps to ensure your changes don't break the working system:

1. Always develop and test in your original working directory
2. Deploy to Cloud Run from your working directory to update the live service
3. Use the provided script to safely update GitHub when needed

### Updating GitHub Safely

When you want to update the GitHub repository:

```bash
# From your working directory
./github_clean_push.sh

# Then follow the instructions to push the clean version
cd /tmp/agent-cy-clean-final && git push -f origin main
```

This process:
- Creates a sanitized copy of your code in a temporary directory
- Removes all sensitive credentials and API keys
- Adds template environment files
- Pushes to GitHub without risking exposure of sensitive information

### Key Components

- `twilio-voice-solution.js`: Core voice agent implementation 
- `assistants-util.js`: OpenAI Assistants API integration
- `functions/src/agents/`: Individual agent implementations
- `public/`: Web interface files

## Web Scraper Integration

The system includes an enhanced web scraper with:

- Lightweight scraping using Cheerio and Axios for simpler pages
- Full browser rendering via Puppeteer for JavaScript-heavy sites
- Integration with OpenAI Assistants API via the `searchWeb` tool
- Automatic URL search capabilities for web research
