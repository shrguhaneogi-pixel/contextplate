require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const axios = require('axios');
const rateLimit = require('express-rate-limit');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app = express();
const PORT = process.env.PORT || 3000;

// Security: Basic Rate Limiting to prevent abuse
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 50, // Limit each IP to 50 requests per `window` (here, per 15 minutes)
  message: { error: 'Too many requests from this IP, please try again after 15 minutes.' },
  standardHeaders: true, 
  legacyHeaders: false, 
});

app.use(cors());
// Security: Restrict incoming JSON payload size to prevent DOS
app.use(express.json({ limit: '10kb' })); 
app.use(express.static(path.join(__dirname, 'public')));

// Apply rate limiting specifically to the API route
app.use('/api/', apiLimiter);

// --- Helper Functions ---

function determineMealType(mood, time) {
  const rules = {
    lazy: { breakfast: 'pastry', lunch: 'sandwich', dinner: 'pizza' },
    healthy: { breakfast: 'smoothie', lunch: 'salad', dinner: 'mediterranean' },
    indulgent: { breakfast: 'pancakes', lunch: 'burger', dinner: 'steak' }
  };
  return rules[mood][time] || 'quick meal';
}

function calculateDistance(lat1, lon1, lat2, lon2) {
  const R = 3958.8; // Radius of earth in miles
  const dLat = (lat2 - lat1) * (Math.PI / 180);
  const dLon = (lon2 - lon1) * (Math.PI / 180);
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(lat1 * (Math.PI / 180)) * Math.cos(lat2 * (Math.PI / 180)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return (R * c).toFixed(1) + ' mi';
}

async function getRestaurant(mealType, lat, lng, budget) {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey || apiKey.includes('your_google')) {
    return {
      name: `Mock ${mealType} Spot`,
      address: '123 Test Ave',
      rating: 4.5,
      priceLevel: budget,
      location: { latitude: lat + 0.01, longitude: lng + 0.01 }
    };
  }

  try {
    const response = await axios.post(
      'https://places.googleapis.com/v1/places:searchText',
      {
        textQuery: mealType,
        locationBias: { circle: { center: { latitude: lat, longitude: lng }, radius: 3000.0 } },
        maxResultCount: 3,
        openNow: true
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': apiKey,
          'X-Goog-FieldMask': 'places.displayName,places.rating,places.formattedAddress,places.priceLevel,places.location'
        }
      }
    );

    const places = response.data.places;
    if (!places || places.length === 0) return null;

    const place = places[0];
    const priceStr = place.priceLevel ? '$'.repeat(place.priceLevel) : budget;

    return {
      name: place.displayName?.text,
      address: place.formattedAddress,
      rating: place.rating,
      priceLevel: priceStr,
      location: place.location
    };
  } catch (error) {
    // Re-throw generic error to avoid leaking Google API internal errors
    throw new Error('Failed to fetch restaurant from Places API.');
  }
}

async function generateExplanation(mealType, placeName, mood, time) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey.includes('your_gemini')) {
    return `Because you're feeling ${mood} at ${time}, ${placeName} is the perfect choice for a ${mealType}.`;
  }

  try {
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
    const prompt = `You are a smart, practical assistant helping a busy professional pick a meal.
Context:
- Mood: ${mood}
- Time of Day: ${time}
- Selected Meal: ${mealType} at ${placeName}

Write a human-like, slightly personalized reasoning for this choice.
Constraints:
- Maximum 2 sentences.
- You MUST explicitly reference their mood, the time of day, and how this choice fits efficiently into their busy schedule.
- Tone: Smart, practical, slightly personalized.`;
    
    const result = await model.generateContent(prompt);
    return (await result.response).text().trim();
  } catch (error) {
    // Fallback explanation so the user still gets a response if AI generation fails
    console.error('Gemini error:', error.message);
    return `Here is a perfect ${mealType} spot that fits your busy schedule!`;
  }
}

// --- Routes ---

app.post('/api/recommend', async (req, res) => {
  try {
    const { mood, budget, time, lat, lng } = req.body;

    // Security: Strict Input Validation & Sanitization
    if (!mood || typeof mood !== 'string' || !['lazy', 'healthy', 'indulgent'].includes(mood.toLowerCase())) {
      return res.status(400).json({ error: 'Invalid or missing mood parameter.' });
    }
    if (!budget || typeof budget !== 'string' || !['$', '$$', '$$$'].includes(budget)) {
      return res.status(400).json({ error: 'Invalid or missing budget parameter.' });
    }
    if (!time || typeof time !== 'string' || !['breakfast', 'lunch', 'dinner'].includes(time.toLowerCase())) {
      return res.status(400).json({ error: 'Invalid or missing time parameter.' });
    }
    if (typeof lat !== 'number' || isNaN(lat) || lat < -90 || lat > 90) {
      return res.status(400).json({ error: 'Invalid latitude. Must be a number between -90 and 90.' });
    }
    if (typeof lng !== 'number' || isNaN(lng) || lng < -180 || lng > 180) {
      return res.status(400).json({ error: 'Invalid longitude. Must be a number between -180 and 180.' });
    }

    // Pass lowercase sanitized values
    const safeMood = mood.toLowerCase();
    const safeTime = time.toLowerCase();

    const mealType = determineMealType(safeMood, safeTime);
    const restaurant = await getRestaurant(mealType, lat, lng, budget);

    if (!restaurant) {
      return res.status(404).json({ error: 'No restaurants found nearby matching your criteria.' });
    }

    const explanation = await generateExplanation(mealType, restaurant.name, safeMood, safeTime);
    const distance = calculateDistance(lat, lng, restaurant.location.latitude, restaurant.location.longitude);

    return res.json({
      success: true,
      data: {
        mealType: mealType,
        restaurant: {
          name: restaurant.name,
          address: restaurant.address,
          rating: restaurant.rating,
          priceLevel: restaurant.priceLevel,
          distance: distance
        },
        explanation: explanation
      }
    });

  } catch (error) {
    // Security: Generic Error Response (avoid leaking stack trace)
    console.error('[API Error]:', error.message);
    return res.status(500).json({ error: 'An internal server error occurred while processing your request.' });
  }
});

app.get('/test', (req, res) => {
  res.json({
    success: true,
    data: {
      mealType: "pizza",
      restaurant: {
        name: "Mock Pizza Spot",
        address: "123 Fake St, Metropolis",
        rating: 4.8,
        priceLevel: "$$",
        distance: "1.2 mi"
      },
      explanation: "Since you're feeling lazy this dinner time, grabbing a quick pizza from Mock Pizza Spot requires zero effort on your part."
    }
  });
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

if (require.main === module) {
  app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
}

module.exports = app;
