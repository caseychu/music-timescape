function generateTimeSeries() {
	var offset = 0;
	var period = 75 * Math.random() + 5;
	var amplitude = 1 * Math.random() + 0.1;
	var series = [];
	for (var i = 0; i < 300; i++)
		//series.push(amplitude * Math.pow(Math.sin(3.14 * i / period), 2) + offset);
		series.push(Math.random());
	return series;
}

var api = (function () {
	function stringify(obj) {
		return Object.keys(obj).map(function (key) {
			return escape(key) + '=' + escape(obj[key])
		}).join('&');
	}

	var count = 1;
	return function api(obj) {
		obj['api_key'] = '1b22e1d1e7f28cd9eb441f258127e5b0';
		obj['format'] = 'json';
		obj['callback'] = 'lastfmcallback' + count++;
		
		return new Promise(function (resolve, reject) {
			window[obj['callback']] = function (data) {
				delete window[obj['callback']];
				if (data['error'])
					reject(data);
				else
					resolve(data);
			};
			setTimeout(reject, 8000);
			
			// Make the request.
			var script = document.createElement('script');
			script.src = 'http://ws.audioscrobbler.com/2.0/?' + stringify(obj);
			document.body.appendChild(script);
		}).catch(function (error) {
			// Retry the request.
			console.error(obj, error);
			return new Promise(function (resolve) {
				setTimeout(function () {
					api(obj).then(resolve);
				}, 5000);
			});
		});
	};
}());

// Batch-call promises n at a time.
Promise.batch = function (n, arr, progress) {
	function handle(resolve, reject) {
		var index = started++;
		if (index < arr.length)
			arr[index]().then(function (value) {
				++finished;
				if (progress)
					progress(finished, arr.length);
					
				values[index] = value;
				handle(resolve, reject);
			}, reject);
		else
			resolve();
	}
	
	var started = 0;
	var finished = 0;
	var values = [];
	var promises = [];
	for (var i = 0; i < n; i++)
		promises.push(new Promise(handle));
	return Promise.all(promises).then(function () { return values; });
};

/*
var i = 0;
function t() {
	var idx = i++;
	return function () {
		return new Promise(function (resolve) {
			setTimeout(function () { console.log('resolved ' + idx); resolve(idx) }, 1000 + Math.random() * 1000);
		});
	};
}
stack = [t(), t(), t(), t(), t(), t(), t(), t(), t(), t(), t(), t(), t()];
Promise.process(stack, 3).then(function (x) { console.log(x) })
*//*

api({
	'method': 'user.getweeklychartlist', 
	'user': 'obscuresecurity'
}).then(function (response) {
		var user = response['weeklychartlist']['@attr']['user'];
		var charts = response['weeklychartlist']['chart'];
		return Promise.batch(5, charts.map(function (chart) {
			return function () {
				return api({
					'method': 'user.getweeklyartistchart',
					'user': 'obscuresecurity',
					'from': chart['from'],
					'to': chart['to']
				});
			};
		}), function (n, m) {
			console.log(n + ' out of ' + m);
		});
	}).then(function (data) {
		localStorage.lastfmdata = data;
		console.log(data);
	})
*/
var data = [
	{
		artist: 'Stars',
		series: generateTimeSeries()
	},
	{
		artist: 'Blue October',
		series: generateTimeSeries()
	},
	{
		artist: 'The Hush Sound',
		series: generateTimeSeries()
	},
	{
		artist: 'Stars',
		series: generateTimeSeries()
	},
	{
		artist: 'Blue October',
		series: generateTimeSeries()
	},
	{
		artist: 'The Hush Sound',
		series: generateTimeSeries()
	},
];
for (var i = 0; i < 3; i ++)
	data = data.concat(data);


window.onload = function () {
	var width = 600;
	var height = 200;
	var line = d3.svg.line()
		.x(function (d, i) { return i * 2; })
		.y(function (d, i) { return height - 50 * d; })
	//	.interpolate('step-before');

	var rows = d3
		.select('#timeline')
		.selectAll('tr')
		.data(data)
		.enter()
		.append('tr');
	
	var i = 0;
	rows.append('td')
		.append('svg')
		.attr('width', width)
		.attr('height', height)
		.append('path')
		.attr('d', function (artist) { return line([0].concat(artist.series, [0])); })
		.attr('stroke', '#666')
		.attr('fill', function () { return 'hsl(' + Math.floor(Math.random() * 360) + ', 73%, 90%)'; });
	
	rows.append('td')
		.text(function (artist) { return artist.artist; })
};