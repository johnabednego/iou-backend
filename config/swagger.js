// config/swagger.js
const swaggerJsdoc = require('swagger-jsdoc');
const swaggerUi = require('swagger-ui-express');

const options = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'IOU API',
      version: '1.0.0',
      description: 'API documentation for IOU App',
    },
    servers: [
      {
        url: 'http://localhost:5000/api',
        description: 'Development server',
      },
    ],
    components: {
      securitySchemes: {
        // cookieAuth uses the session cookie name used by express-session
        cookieAuth: {
          type: 'apiKey',
          in: 'cookie',
          name: 'connect.sid' // adjust if you change session cookie name
        }
      }
    }
  },
  apis: ['./routes/*.js'],
};

const swaggerSpec = swaggerJsdoc(options);

const setupSwaggerDocs = (app) => {
  // swaggerOptions: requestInterceptor ensures fetch uses credentials: 'include'
  const swaggerUiOptions = {
    swaggerOptions: {
      requestInterceptor: (req) => {
        // this runs in the browser and tells fetch/XHR to include cookies
        req.credentials = 'include';
        return req;
      },
    },
  };

  app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec, swaggerUiOptions));
};

module.exports = setupSwaggerDocs;
