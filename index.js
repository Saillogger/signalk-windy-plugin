/*
 * Copyright 2019-2024 Ilker Temir <ilker@ilkertemir.com>
 * Copyright 2024 Saillogger LLC <info@saillogger.com>
 * 
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

const POLL_INTERVAL = 1      // Poll every N seconds
const API_BASE = 'https://stations.windy.com./pws/update/';
const request = require('request')

const median = arr => {
  const mid = Math.floor(arr.length / 2),
    nums = [...arr].sort((a, b) => a - b);
  return arr.length % 2 !== 0 ? nums[mid] : (nums[mid - 1] + nums[mid]) / 2;
};

module.exports = function(app) {
  var plugin = {};
  var unsubscribes = [];
  var submitProcess;
  var statusProcess;
  var lastSuccessfulUpdate;
  var name = app.getSelfPath('name');

  var position;
  var windSpeed = [];
  var windGust;
  var windDirection;
  var waterTemperature;
  var temperature;
  var pressure;
  var humidity;

  plugin.id = "signalk-windy";
  plugin.name = "SignalK Windy.com";
  plugin.description = "Windy.com plugin for Signal K";

  plugin.schema = {
    type: 'object',
    required: ['apiKey', 'submitInterval', 'stationId'],
    properties: {
      apiKey: {
        type: 'string',
        title: 'API Key (obtain from stations.windy.com)'
      },
      submitInterval: {
        type: 'number',
        title: 'Submit Interval (minutes)',
        default: 5
      },
      stationId: {
        type: 'number',
        title: 'Windy.com Station ID',
        default: 100 
      },
      provider: {
        type: 'string',
        title: 'Provider',
        default: ''
      },
      url: {
        type: 'string',
        title: 'Web Site',
        default: ''
      },
      paths: {
        type: 'object',
        title: 'Signal K Paths',
        properties: {
          position: {
            type: 'string',
            title: 'Position Path',
            default: 'navigation.position'
          },
          windDirection: {
            type: 'string',
            title: 'Wind Direction Path',
            default: 'environment.wind.directionGround'
          },
          windSpeed: {
            type: 'string',
            title: 'Wind Speed Path',
            default: 'environment.wind.speedOverGround'
          },
          waterTemperature: {
            type: 'string',
            title: 'Water Temperature Path',
            default: 'environment.water.temperature'
          },
          outsideTemperature: {
            type: 'string',
            title: 'Outside Temperature Path',
            default: 'environment.outside.temperature'
          },
          pressure: {
            type: 'string',
            title: 'Pressure Path',
            default: 'environment.outside.pressure'
          },
          humidity: {
            type: 'string',
            title: 'Humidity Path',
            default: 'environment.outside.humidity'
          }
        }
      }
    }
  }

  plugin.start = function(options) {
    if (!options.apiKey) {
      app.error('API Key is required');
      return
    } 

    // Initialize paths object if it doesn't exist
    options.paths = options.paths || {};

    app.setPluginStatus(`Submitting weather report every ${options.submitInterval} minutes`);

    let subscription = {
      context: 'vessels.self',
      subscribe: [{
        path: options.paths.position || 'navigation.position',
        period: POLL_INTERVAL * 1000
      }, {
        path: options.paths.windDirection || 'environment.wind.directionGround',
        period: POLL_INTERVAL * 1000
      }, {
        path: options.paths.windSpeed || 'environment.wind.speedOverGround',
        period: POLL_INTERVAL * 1000
      }, {
        path: options.paths.waterTemperature || 'environment.water.temperature',
        period: POLL_INTERVAL * 1000
      }, {
        path: options.paths.outsideTemperature || 'environment.outside.temperature',
        period: POLL_INTERVAL * 1000
      }, {
        path: options.paths.pressure || 'environment.outside.pressure',
        period: POLL_INTERVAL * 1000
      }, {
        path: options.paths.humidity || 'environment.outside.humidity',
        period: POLL_INTERVAL * 1000
      }]
    };

    app.subscriptionmanager.subscribe(subscription, unsubscribes, function() {
      app.debug('Subscription error');
    }, data => processDelta(data));

    app.debug(`Starting submission process every ${options.submitInterval} minutes`);

    statusProcess = setInterval( function() {
      function metersPerSecondToKnots(ms) {
        if (ms == null) {
          return null;
        }
        return Math.round(ms * 1.94384 * 10) / 10;
      }

      var statusMessage;
      if (lastSuccessfulUpdate) {
        let since = timeSince(lastSuccessfulUpdate);
        statusMessage = `Successful submission ${since} ago. `;
      } else {
        statusMessage = `No data has been submitted yet. `;
      }
      if ((windSpeed.length > 0) && (windGust != null)) {
        let currentWindSpeed = windSpeed[windSpeed.length-1];
        let currentWindSpeedKts = metersPerSecondToKnots(currentWindSpeed);
        let windGustKts = metersPerSecondToKnots(windGust);
        statusMessage += `Wind speed is ${currentWindSpeedKts}kts and gust is ${windGustKts}kts.`;
      } 
      app.setPluginStatus(statusMessage);
    }, 5 * 1000);

    submitProcess = setInterval( function() {
      if ( (position == null) || (windSpeed.length == 0) || (windDirection == null) ||
           (temperature == null) ) {
        let message = 'Not submitting position due to lack of position, wind ' +
                     'speed, wind direction or temperature.';
        app.debug(message);
        return
      }
      let data = {
        stations: [
          { station: options.stationId,
            name: name,
            shareOption: 'Open',
            type: 'Boat (powered by Saillogger.com Signal K plugin)',
            provider: options.provider,
            url: options.url,
            lat: position.latitude,
            lon: position.longitude,
            elevation: 1 }
        ],
        observations: [
          { station: options.stationId,
            temp: temperature,
            wind: median(windSpeed),
            gust: windGust,
            winddir: windDirection,
            pressure: pressure,
            rh: humidity }
        ]
      }
    
      let httpOptions = {
        uri: API_BASE + options.apiKey,
        method: 'POST',
        json: data
      };

      app.debug(`Submitting data: ${JSON.stringify(data)}`);
      request(httpOptions, function (error, response, body) {
        if (!error && response.statusCode == 200) {
          app.debug('Weather report successfully submitted');
          lastSuccessfulUpdate = Date.now();
          position = null;
          windSpeed = [];
          windGust = null;
          windDirection = null;
          waterTemperature = null;
          temperature = null;
          pressure = null;
          humidity = null;
        } else {
          app.debug('Error submitting to Windy.com API');
          app.debug(body); 
        }
      }); 
    }, options.submitInterval * 60 * 1000);
  }

  plugin.stop =  function() {
    clearInterval(statusProcess);
    clearInterval(submitProcess);
    app.setPluginStatus('Pluggin stopped');
  };

  function radiantToDegrees(rad) {
    return rad * 57.2958;
  }

  function kelvinToCelsius(deg) {
    return deg - 273.15;
  }

  function processDelta(data) {
    if (!data.updates || !data.updates.length || !data.updates[0].values || !data.updates[0].values.length) {
      return;
    }
    let dict = data.updates[0].values[0];
    let path = dict.path;
    let value = dict.value;

    switch (path) {
      case 'navigation.position':
      case options.paths?.position:
        position = value;
        break;
      case 'environment.wind.speedOverGround':
      case options.paths?.windSpeed:
        let speed = value.toFixed(2);
        speed = parseFloat(speed);
        if ((windGust == null) || (speed > windGust)) {
          windGust = speed;
        }
        windSpeed.push(speed);
        break;
      case 'environment.wind.directionGround':
      case options.paths?.windDirection:
        windDirection = radiantToDegrees(value);
        windDirection = Math.round(windDirection);
        break;
      case 'environment.water.temperature':
      case options.paths?.waterTemperature:
        waterTemperature = kelvinToCelsius(value);
        waterTemperature = waterTemperature.toFixed(1);
        waterTemperature = parseFloat(waterTemperature);
        break;
      case 'environment.outside.temperature':
      case options.paths?.outsideTemperature:
        temperature = kelvinToCelsius(value);
        temperature = temperature.toFixed(1);
        temperature = parseFloat(temperature);
        break;
      case 'environment.outside.pressure':
      case options.paths?.pressure:
        pressure = parseFloat(value);
        break;
      case 'environment.outside.humidity':
      case options.paths?.humidity:
        humidity = Math.round(100*parseFloat(value));
        break;
      default:
        app.debug('Unknown path: ' + path);
    }
  }

  function timeSince(date) {
    var seconds = Math.floor((new Date() - date) / 1000);
    var interval = seconds / 31536000;
    if (interval > 1) {
      return Math.floor(interval) + " years";
    }
    interval = seconds / 2592000;
    if (interval > 1) {
      return Math.floor(interval) + " months";
    }
    interval = seconds / 86400;
    if (interval > 1) {
      return Math.floor(interval) + " days";
    }
    interval = seconds / 3600;
    if (interval > 1) {
      let time = Math.floor(interval);
      if (time == 1) {
        return (`${time} hour`);
      } else {
        return (msg = `${time} hours`);
      }
    }
    interval = seconds / 60;
    if (interval > 1) {
      let time = Math.floor(interval);
      if (time == 1) {
        return (`${time} minute`);
      } else {
        return (msg = `${time} minutes`);
      }
    }
    return Math.floor(seconds) + " seconds";
  }

  return plugin;
}
