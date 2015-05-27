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

function go(username) {
	api({
		'method': 'user.getweeklychartlist', 
		'user': username
	}).then(function (response) {
		var user = response['weeklychartlist']['@attr']['user'];
		var charts = response['weeklychartlist']['chart'];
		return Promise.parallel(
			5,
			charts.map(function (chart) {
				return function () {
					return api({
						'method': 'user.getweeklyartistchart',
						'user': username,
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

function processData(data) {
	// Filter empty weeks and (just in case) make sure it's in order...
	data = data
		.filter(function (week) {
			return week && !week['error'] && week['weeklyartistchart']['artist'];
		})
		.sort(function (w1, w2) {
			return w1['weeklyartistchart']['@attr']['from'] - w2['weeklyartistchart']['@attr']['from'];
		});
	
	if (data.length == 0)
		throw new Error('No data!');
	
	var startDate = data[0]['weeklyartistchart']['@attr']['from'];
	var endDate = data[data.length - 1]['weeklyartistchart']['@attr']['to'];
	var weekLength = 60 * 60 * 24 * 7;
	var weekCount = (endDate - startDate) / weekLength;

	// Go through each week and count the plays for each artist.
	var artists = {};
	data.forEach(function (week, weekNumber) {
		var weekNumber = (week['weeklyartistchart']['@attr']['from'] - startDate) / weekLength;
	
		// If there's only one artist this week, Last.fm doesn't wrap it in an array...
		if (!(week['weeklyartistchart']['artist'] instanceof Array))
			week['weeklyartistchart']['artist'] = [week['weeklyartistchart']['artist']];
	
		week['weeklyartistchart']['artist'].forEach(function (artist) {
			// Create a new entry for this artist if it doesn't exist.
			if (!artists[artist['name'] + artist['mbid']]) {
				artists[artist['name'] + artist['mbid']] = {
					name: artist['name'],
					url: artist['url'],
					plays: new Array(weekCount),
					totalPlays: 0,
					maxPlays: -1,
					maxWeek: null,
				};
			}
			
			// Update info.
			var artistInfo = artists[artist['name'] + artist['mbid']];
			var playCount = +artist['playcount'];
			artistInfo.plays[weekNumber] = playCount;
			artistInfo.totalPlays += playCount;
			if (playCount > artistInfo.maxPlays) {
				artistInfo.maxPlays = playCount;
				artistInfo.maxWeek = weekNumber;
			}
		});
	});
	
	return {
		artists: Object.keys(artists).map(function (key) { return artists[key]; }),
		startDate: new Date(startDate * 1000),
		endDate: new Date(endDate * 1000),
		weekCount: weekCount
	};
}

function draw(data) {
	
	var width = 800;
	var height = 13;
	var paddingTop = 100;
	var chartHeight = height * data.artists.length;
	var totalHeight = paddingTop + chartHeight;
	var scale = 0.5;
	
	var timeline = d3
		.select('#timeline')
		.attr('width', width + 150)
		.attr('height', totalHeight);
	
	// Year labels.
	d3.time.year.utc.range(data.startDate, data.endDate).forEach(function (yearDate) {
		var percentage = (yearDate - data.startDate) / (data.endDate - data.startDate);
		
		// Draw a vertical line at the beginning of each year.
		timeline
			.append('path')
			.attr('d', 'M' + [width * percentage, -20 + paddingTop] + 'v' + (20 + chartHeight))
			.attr('stroke', '#ccc');
			
		// The actual label; only show it if there's enough room (let's say, a fifth of a year).
		if (data.endDate - yearDate > 365 * 24 * 60 * 60 * 1000 / 5)
			timeline
				.append('text')
				.attr('x', width * percentage + 5)
				.attr('y', paddingTop - 7)
				.attr('fill', '#666')
				.text(yearDate.getUTCFullYear());
	});
	
	// Artist plots.
	var line = d3.svg.line()
		.x(function (plays, weekNumber) { return weekNumber * (width / (data.weekCount + 2)); })
		.y(function (plays, weekNumber) { return -scale * plays || 0; })
		.interpolate('basis');
	var artist = timeline
		.selectAll('g')
		.data(data.artists)
		.enter()
		.append('g')
		.attr('transform', function (artist, artistNumber) {
			return 'translate(0, ' + (height * artistNumber + paddingTop) + ')';
		});
	artist.append('path')
		.attr('fill', function (artist, i) { return 'hsla(' + (Math.floor(i * 31 % 360)) + ', 100%, 80%, 0.7)'; })
		.attr('stroke', '#666')
		.attr('d', function (artist, artistNumber) { return line([0].concat(artist.plays, [0])); })
		/*
		.attr('transform', 'scale(1, 0.001)')
		.transition()
		.delay(1000)
		.duration(20000)
		.ease('elastic')
		.attr('transform', 'scale(1, 1)');
		*/
	
	// The artist text.
	artist
		.append('text')
		.attr('x', width)
		.attr('y', 3)
		.attr('fill', '#666')
		.text(function (artist) { return artist.name; });
}

function save(fileName, zoom) {
	var zoom = zoom || 2;
	var fileName = fileName || 'image';

	var timeline = document.querySelector('#timeline');
	var img = new Image();
	img.onload = function () {		
		// Render the SVG to a <canvas>
		var canvas = document.createElement('canvas');
		canvas.width = zoom * timeline.getAttribute('width');
		canvas.height = zoom * timeline.getAttribute('height');
		var ctx = canvas.getContext('2d');
		ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
		
		// Save the image.
		var a = document.createElement('a');
		a.download = fileName + '.png';
		a.href = canvas.toDataURL('image/png');
		a.click();
		window.URL.revokeObjectURL(img.src);
	};
	img.src = window.URL.createObjectURL(new Blob([timeline.outerHTML], {type: 'image/svg+xml'}));
}

window.onload = function () {
	var data = processData(JSON.parse(localStorage.lastfmdata));
	data.artists = data.artists
		.filter(function (artist) { return artist.maxPlays > 30 || (artist.totalPlays > 300 && artist.maxPlays > 50); })
		.sort(function (a1, a2) { return -(a1.totalPlays - a2.totalPlays); })
		.slice(0, 50)
		.sort(function (a1, a2) { return -(a1.maxWeek - a2.maxWeek); })
	draw(data);
};