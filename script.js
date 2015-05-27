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

function stringify(obj) {
	return Object.keys(obj).map(function (key) {
		return encodeURIComponent(key) + '=' + encodeURIComponent(obj[key])
	}).join('&');
}

var lastfm = (function () {

	var count = 1;
	return function lastfm(obj) {
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
					lastfm(obj).then(resolve);
				}, 5000);
			});
		});*/
	};
}());

// Spotify API... currently unauthenticated GET endpoints only.
var spotify = function (endpoint, params) {
	return new Promise(function (resolve, reject) {
		var xhr = new XMLHttpRequest();
		xhr.open('GET', 'https://api.spotify.com/v1/' + endpoint + '?' + stringify(params), true);
		xhr.onload = function () {
			resolve(JSON.parse(this.responseText));
		};
		xhr.onerror = reject;
		xhr.send();
	});
};

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
};

function delay(ms, value) {
	return new Promise(function (resolve) {
		setTimeout(resolve, ms, value);
	});
}

function go(username) {
	Promise.all([
		lastfm({
			'method': 'user.getinfo',
			'user': username
		}),
		lastfm({
			'method': 'user.getweeklychartlist', 
			'user': username
		})
	]).then(function (response) {
		var charts = response[1]['weeklychartlist']['chart'];
	
		// Don't fetch the weeks from before the user signed up.
		var registeredTime = +response[0]['user']['registered']['unixtime'];
		while (charts.length && +charts[0]['to'] < registeredTime)
			charts.shift();
			
		return Promise.parallel(
			5,
			charts.map(function (chart) {
				return function () {
					return lastfm({
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

	// Go through each week and count the plays for each artist.
	var artists = {};
	data.forEach(function (week, weekNumber) {
	
		// If there's only one artist this week, Last.fm doesn't wrap it in an array...
		if (!(week['weeklyartistchart']['artist'] instanceof Array))
			week['weeklyartistchart']['artist'] = [week['weeklyartistchart']['artist']];
	
		week['weeklyartistchart']['artist'].forEach(function (artist, rank) {
			// Create a new entry for this artist if it doesn't exist.
			if (!artists[artist['name'] + artist['mbid']]) {
				artists[artist['name'] + artist['mbid']] = {
					name: artist['name'],
					url: artist['url'],
					plays: {},
					totalPlays: 0,
					maxPlays: -1,
					maxWeek: null,
					topRank: Infinity
				};
			}
			
			// Update info.
			var artistInfo = artists[artist['name'] + artist['mbid']];
			var playCount = +artist['playcount'];
			var weekDate = week['weeklyartistchart']['@attr']['from'] * 1000;
			artistInfo.plays[weekDate] = playCount;
			artistInfo.totalPlays += playCount;
			if (playCount > artistInfo.maxPlays) {
				artistInfo.maxPlays = playCount;
				artistInfo.maxWeek = weekDate;
			}
			if (rank < artistInfo.topRank)
				artistInfo.topRank = rank;
		});
	});
	
	return {
		user: data[0]['weeklyartistchart']['@attr']['user'],
		artists: Object.keys(artists).map(function (key) { return artists[key]; }),
		weeks: data.map(function (week) {
			return {
				from: week['weeklyartistchart']['@attr']['from'] * 1000, 
				to: week['weeklyartistchart']['@attr']['to'] * 1000
			};
		}),
		startDate: new Date(data[0]['weeklyartistchart']['@attr']['from'] * 1000),
		endDate: new Date(data[data.length - 1]['weeklyartistchart']['@attr']['to'] * 1000)
	};
}

function draw(data) {

	var width = 800;
	var height = 13;
	var paddingTop = 100;
	var chartHeight = height * data.artists.length;
	var totalHeight = paddingTop + chartHeight;
	var paddingAxis = 20;
	
	// I want 10% of the peaks to be over 120 pixels.
	var maxPlays = d3.quantile(
		data
			.artists.map(function (a) { return a.maxPlays; })
			.sort(d3.ascending),
		0.9);
	var scale = 120 / maxPlays;
	
	var timeline = d3
		.select('#timeline')
		.attr('width', width + 150)
		.attr('height', totalHeight);
	
	// Year labels.
	var yearScale = d3.time.scale.utc()
		.domain([data.startDate, data.endDate])
		.range([0, width]);
	timeline
		.append('g')
		.attr('class', 'axis')
		.attr('transform', 'translate(0,' + (paddingTop - paddingAxis) + ')')
		.call(
			d3.svg.axis()
				.scale(yearScale)
				.orient('top')
				.ticks(d3.time.year.utc, 1)
				.tickSize(-(chartHeight + paddingAxis), 0)
				.tickFormat(function (yearDate) {
					// Only show the year if there's enough room
					if (width - yearScale(yearDate) > 30)
						return yearDate.getUTCFullYear();
					return '';
				})
		);

	timeline
		.selectAll('g.artist')
		.data(data.artists)
		.enter()
		.append('g')
		.attr('class', 'artist')
		.attr('transform', function (artist, artistNumber) {
			return 'translate(0, ' + (height * artistNumber + paddingTop) + ')';
		})
		.call(function (artist) {
			// Artist plots.
			var line = d3.svg.line()
				.x(function (plays) { return yearScale(plays[0]); })
				.y(function (plays) { return -scale * plays[1]; })
				.interpolate('basis');
			artist.append('path')
				.attr('fill', function (artist, i) { return 'hsla(' + (Math.floor(i * 31 % 360)) + ', 100%, 80%, 0.7)'; })
				.attr('d', function (artist, artistNumber) {
					var points = data.weeks.map(function (week) {
						return [(week.from + week.to) / 2, artist.plays[week.from] || 0];
					});
					
					points.unshift([data.startDate, 0]);
					points.push([data.endDate, 0]);
					while (points.length >= 2 && points[0][1] === 0 && points[1][1] === 0)
						points.shift();
					return line(points);
				});
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
				.attr('x', width + 4)
				.attr('dy', '0.4em')
				.text(function (artist) { return artist.name; });
		});
		
	timeline.on('click', function () {
		var x = d3.mouse(this)[0];
		if (x > width)
			return;
			
		// Find the closest week to the one clicked.
		var date = yearScale.invert(x);
		var weekLength = 7 * 24 * 60 * 60 * 1000;
		for (var i = 0; i < data.weeks.length; i++)
			if (data.weeks[i].to >= +date + weekLength)
				break;
		
		if (i === data.weeks.length) {
			debugger;
			throw new Error('why?')
		}
		
		cursor
			.classed('loading', true)
			.style('left', yearScale((data.weeks[i].from + data.weeks[i].to) / 2) + 'px');
		
		if (playController) {
			playController.pause();
			Player.stop();
		}
		playController = new Interrupt();
		play(i, playController);
		/*setTimeout(function () {
			playController.pause()
		}, 1000);*/
	});
		
	var playController = false;
	var cursor = d3
		.select('#cursor')
		.style('height', (chartHeight + paddingAxis) + 'px')
		.style('top', (paddingTop - paddingAxis) + 'px');
	function stop() {
		cursor
			.classed('playing', false)
			.classed('loading', false);
	}
	function play(weekNumber, interrupt) {
		var week = data.weeks[weekNumber];
		if (!week)
			return;
		interrupt = interrupt || Promise.resolve();
		
		return lastfm({
			'method': 'user.getweeklytrackchart', 
			'user': data.user,
			'from': week.from / 1000,
			'to': week.to / 1000
		})
		.then(interrupt)
		.then(function (chart) {
			if (!chart['weeklytrackchart']['track'])
				return;
					
			var tracks = chart['weeklytrackchart']['track'].slice(0, 3).reverse();
			var promise = Promise.resolve();
			tracks.forEach(function (track) {
				var name = track['name'];
				var artist = track['artist']['#text'];
				console.log(track);
				promise = promise
					.then(function () {
						return spotify('search', {
							'type': 'track',
							'q': 'track:' + name + ' artist:' + artist,
							'limit': 1
						});
					})
					.then(interrupt)
					.then(function (result) {
						console.log(result);
						var results = result['tracks']['items'];
						if (results.length && interrupt.running)
							Player.push(results[0]['preview_url']);
					})
					.then(interrupt);
			});
			return promise;
		})
		.then(function () {
			//return play(weekNumber + 1, interrupt);
		});
	}	
}

function Interrupt() {
	var blocked = [];
	var interrupt = function (value) {
		if (interrupt.running)
			return value;
		else
			return new Promise(function (resolve) {
				blocked.push(resolve);
			});
	};
	interrupt.running = true;
	interrupt.pause = function () {
		interrupt.running = false;
	};
	interrupt.resume = function () {
		interrupt.running = true;
		while (blocked.length)
			blocked.pop()();
	};
	return interrupt;
}

var Player = (function () {
	var stopDuration = 500;
	var startDuration = 750;
	
	// Fade a song in/out.
	function fade(audio, from, to, duration) {
		var scale = d3.scale.linear().domain([0, duration]).range([from, to]).clamp(true);
		d3.timer(function (t) {
			audio.volume = scale(t);
			return t > duration;
		});
	}
	
	var current = false;
	var queue = [];
	function play() {
		if (current) {
			fade(current, 0, 1, startDuration);
			current.play();
		}
	}
	function next() {
		if (current)
			fade(current, 1, 0, stopDuration);
		current = queue.shift();
	}
	function stop() {
		queue = [];
		next();
	}
	function push(src) {
		console.log('loading', src);
		var audio = new Audio();
		audio.ontimeupdate = function () {
			// To do: what if the audio pauses automatically to buffer?
			console.log(audio.currentTime, audio.duration);
			if (audio.ended || audio.currentTime + 2*stopDuration/1000 > audio.duration || (audio.currentTime > 5 && queue.length)) {
				audio.ontimeupdate = null;
				next();
				play();
			}
		};
		audio.preload = 'auto';
		audio.src = src;
		queue.push(audio);
		
		if (!current) {
			next();
			play();
		}
	}

	return {
		next: next,
		stop: stop,
		push: push
	};
}());


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
		a.innerHTML = 'download';
		a.download = fileName + '.png';
		a.href = canvas.toDataURL('image/png');
		a.click();
		document.body.appendChild(a);
		window.URL.revokeObjectURL(img.src);
	};
	img.src = window.URL.createObjectURL(new Blob([timeline.outerHTML], {'type': 'image/svg+xml'}));
}

window.onload = function () {
	var data = processData(JSON.parse(localStorage.lastfmdata));
	data.artists = data.artists
		.filter(function (artist) { return artist.maxPlays > 30 || (artist.totalPlays > 300 && artist.maxPlays > 50) || artist.topRank < 2; })
		.sort(function (a1, a2) { return -(a1.totalPlays - a2.totalPlays); })
		.slice(0, 50)
		.sort(function (a1, a2) { return -(a1.maxWeek - a2.maxWeek); })
	draw(data);
};