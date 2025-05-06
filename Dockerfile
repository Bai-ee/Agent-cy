# Use official Node.js LTS image
FROM node:18

# Set working directory
WORKDIR /app

# Copy package files and install dependencies
COPY package*.json ./
RUN npm install

# Copy the rest of the code
COPY . .

# Cloud Run requires the app to listen on port 8080
ENV PORT=8080

# Expose port 8080
EXPOSE 8080

# Start the app
CMD ["node", "twilio-voice-solution.js"]
