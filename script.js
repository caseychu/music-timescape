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
		//obj['api_key'] = '1b22e1d1e7f28cd9eb441f258127e5b0';
		obj['api_key'] = 'b7472d0a7326602639ae462914ad9d2d';
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
		})/*.catch(function (error) {
			// Retry the request.
			console.error(obj, error);
			return new Promise(function (resolve) {
				setTimeout(function () {
					api(obj).then(resolve);
				}, 5000);
			});
		});*/
	};
}());

// Parallelize an array of functions that return promises.
Promise.parallel = function (n, arr, progress) {
	progress = progress || function () {};
	return new Promise(function (resolve, reject) {	
		function work() {
			if (started < arr.length) {
				var index = started++;
				arr[index]()
					.catch(function (error) {
						// Just eat errors
						console.error(error);
						return error;
					})
					.then(function (value) {
						values[index] = value;
						return progress(++finished, arr.length, started);
					})
					.then(work);
			}
			
			if (finished >= arr.length)
				resolve(values);
		}
		
		var started = 0;
		var finished = 0;
		var values = [];
		for (var i = 0; i < n; i++)
			work();
	});
}

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
*/
function delay(ms, value) {
	return new Promise(function (resolve) {
		setTimeout(function () { resolve(value); }, ms);
	});
}

function go() {
	api({
		'method': 'user.getweeklychartlist', 
		'user': 'obscuresecurity'
	}).then(function (response) {
		var user = response['weeklychartlist']['@attr']['user'];
		var charts = response['weeklychartlist']['chart'];
		return Promise.parallel(
			5,
			charts.map(function (chart) {
				return function () {
					return api({
						'method': 'user.getweeklyartistchart',
						'user': 'obscuresecurity',
						'from': chart['from'],
						'to': chart['to']
					});
				};
			}),
			function (n, m, q) {
				console.log(n + ' out of ' + m, (q - n) + ' running');
				//return delay(Math.random() * 1000);
			}
		);
	}).then(function (data) {
		localStorage.lastfmdata = JSON.stringify(data);
		console.log(data);
	});
}

function keyForWeek(week) {
	return week['weeklyartistchart']['@attr']['from'] + '-' + week['weeklyartistchart']['@attr']['to'];
}

window.onload = function () {
	var data = JSON.parse(localStorage.lastfmdata);
	
	data = data.slice(280);
	var artists = {};
	var weekCount = data.length;
	data.forEach(function (week, weekNumber) {
		if (!week || week['error'] || !week['weeklyartistchart']['artist'])
			return;
		week['weeklyartistchart']['artist'].forEach(function (artist) {
			if (!artists[artist['mbid']]) {
				artists[artist['mbid']] = {
					name: artist['name'],
					url: artist['url'],
					plays: [],
					totalPlays: 0,
					maxPlays: -1,
					maxWeek: null,
				};
				artists[artist['mbid']].plays.length = weekCount;
			}
			
			artists[artist['mbid']].plays[weekNumber] = +artist['playcount'];
			artists[artist['mbid']].totalPlays += +artist['playcount'];
			if (+artist['playcount'] > artists[artist['mbid']].maxPlays) {
				artists[artist['mbid']].maxPlays = +artist['playcount'];
				artists[artist['mbid']].maxWeek = weekNumber;
			}
		});
	});
	
	
	var artists = Object.keys(artists).map(function (key) { return artists[key]; })
		.filter(function (artist) { return artist.maxPlays > 30; })
		.filter(function (artist) { return artist.totalPlays > 10; })
		.sort(function (a1, a2) { return -(a1.maxWeek - a2.maxWeek); });

	var width = 600;
	var height = 15;
	var paddingTop = 100;
	var totalHeight = paddingTop + 15 * artists.length;
	var scale = 0.4;
	
	var i = 0;
	var group = d3
		.select('#timeline')
		.attr('width', width + 200)
		.attr('height', totalHeight)
		.selectAll('g')
		.data(artists)
		.enter()
		.append('g')
		.attr('transform', function (artist, artistNumber) {
			return 'translate(0, ' + (height * artistNumber + paddingTop) + ')';
		});
		
	group.append('path')
		.attr('d', function (artist, artistNumber) {
			var line = d3.svg.line()
				.x(function (plays, weekNumber) { return weekNumber * (width / weekCount); })
				.y(function (plays, weekNumber) { return -scale * plays || 0; })
				//.interpolate('step-before');
				.interpolate('basis');
			return line([0].concat(artist.plays, [0])); 
		})
		.attr('stroke', '#666')
		.attr('fill', function (artist, i) { return 'hsla(' + Math.floor(i * 37 % 360) + ', 100%, 80%, 0.7)'; });
	
	group
		.append('text')
		.attr('x', width + 10)
		.text(function (artist) { return artist.name; })
};