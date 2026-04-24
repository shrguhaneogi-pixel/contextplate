const assert = require('assert');
const http = require('http');
const app = require('./server');

// Start the server on a random port
const server = app.listen(0, () => {
  const port = server.address().port;
  console.log(`Starting tests on http://localhost:${port}...`);

  http.get(`http://localhost:${port}/test`, (res) => {
    let data = '';

    res.on('data', (chunk) => { data += chunk; });

    res.on('end', () => {
      try {
        const response = JSON.parse(data);
        
        // Validate Status Code
        assert.strictEqual(res.statusCode, 200, 'Status code should be 200');
        console.log('✔ Status code is 200');

        // Validate Response Format
        assert.strictEqual(response.success, true, 'Response success should be true');
        assert.ok(response.data, 'Response should contain a data object');
        
        // Validate Data Fields
        assert.ok(response.data.mealType, 'Data should contain mealType');
        assert.ok(response.data.restaurant, 'Data should contain a restaurant object');
        assert.ok(response.data.restaurant.name, 'Restaurant should contain a name');
        assert.ok(response.data.restaurant.address, 'Restaurant should contain an address');
        assert.ok(response.data.explanation, 'Data should contain an explanation');

        console.log('✔ API response format is valid');
        console.log('\n✅ All tests passed successfully!');
      } catch (err) {
        console.error('\n❌ Test failed:', err.message);
        process.exitCode = 1;
      } finally {
        server.close();
      }
    });
  }).on('error', (err) => {
    console.error('\n❌ Request failed:', err.message);
    server.close();
    process.exitCode = 1;
  });
});
