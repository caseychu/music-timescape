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

function go(user) {
	Promise.all([
		lastfm({
			'method': 'user.getinfo',
			'user': user
		}),
		lastfm({
			'method': 'user.getweeklychartlist', 
			'user': user
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
						'user': user,
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
	var weeks = data
		// Remove empty weeks.
		.filter(function (week) { return week && !week['error']; })
	
		// Normalize the data, as Last.fm is really, really inconsistent...
		.map(function (week) {
			var rec = week['weeklyartistchart'];			
			if (rec['artist'])
				return {
					user: rec['@attr']['user'],
					from: 1000 * rec['@attr']['from'],
					to: 1000 * rec['@attr']['to'],
					artists: 
						rec['artist'] instanceof Array
							? week['weeklyartistchart']['artist']
							: [week['weeklyartistchart']['artist']]
				};
			
			return {
				user: rec['user'],
				from: 1000 * rec['from'],
				to: 1000 * rec['to'],
				artists: []
			};
		})
		.sort(function (w1, w2) {
			return w1.from - w2.from;
		});

	// Go through each week and count the plays for each artist.
	var artists = {};
	weeks.forEach(function (week, weekNumber) {	
		week.artists.forEach(function (artist, rank) {
			var key = artist['name'] + artist['mbid'];
			// Create a new entry for this artist if it doesn't exist.
			if (!artists[key]) {
				artists[key] = {
					name: artist['name'],
					url: artist['url'],
					plays: {},
					
					// Summary statistics
					totalPlays: 0,
					maxPlays: -1,
					maxWeek: null,
					startWeek: null,
					topRank: Infinity
				};
			}
			
			// Update info.
			var plays = +artist['playcount'];
			artists[key].plays[week.from] = plays;
			artists[key].totalPlays += plays;
			if (plays > artists[key].maxPlays) {
				artists[key].maxPlays = plays;
				artists[key].maxWeek = week.from;
			}
			if (artists[key].startWeek === null)
				artists[key].startWeek = week.from;
			if (rank < artists[key].topRank)
				artists[key].topRank = rank;
		});
	});
	
	return {
		artists: d3.values(artists),
		weeks: weeks
	};
}

function draw(data) {
	// Do some filtering...
	data.artists = data.artists
		.filter(function (artist) { return artist.maxPlays > 30 || (artist.totalPlays > 300 && artist.maxPlays > 50) || artist.topRank < 2; })
		.sort(function (a1, a2) { return -(a1.totalPlays - a2.totalPlays); })
		.slice(0, 50)
		.sort(function (a1, a2) { return -(a1.maxWeek - a2.maxWeek); });
	
	// Chop off the first 1% of weeks (with data), to remove extreme outliers.
	data.weeks = data.weeks.slice(d3.bisect(
		data.weeks.map(function (week) { return week.from; }),
		d3.quantile(
			data.artists.map(function (a) { return a.startWeek; }).sort(d3.ascending),
			0.1
		)
	));
	
	if (data.weeks.length === 0)
		throw new Error('No data!');
	var user = data.weeks[0].user;
	var startDate = data.weeks[0].from;
	var endDate = data.weeks[data.weeks.length - 1].to;

	var width = 800;
	var height = 13;
	var paddingTop = 100;
	var chartHeight = height * data.artists.length;
	var totalHeight = paddingTop + chartHeight;
	var paddingAxis = 20;
	
	// I want 10% of the peaks to be over 120 pixels tall.
	var maxPlays = d3.quantile(
		data.artists.map(function (a) { return a.maxPlays; }).sort(d3.ascending),
		0.9);
	var scale = 120 / maxPlays;
	
	var timeline = d3
		.select('#timeline')
		.attr('width', width + 130)
		.attr('height', totalHeight);
	
	// Year labels.
	var yearScale = d3.time.scale.utc()
		.domain([startDate, endDate])
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
					if (width - yearScale(yearDate) < 30)
						return '';
					return yearDate.getUTCFullYear();
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
					
					points.unshift([startDate, 0]);
					points.push([endDate, 0]);
					while (points.length >= 2 && points[0][1] === 0 && points[1][1] === 0)
						points.shift();
					return line(points);
				})
				/*
				.attr('transform', 'scale(1, 0.001)')
				.transition()
				.delay(1000)
				.duration(1500)
				.attr('transform', 'scale(1, 1)');
				*/
			
			// The artist text.
			artist
				.append('text')
				.attr('x', width)
				.text(function (artist) { return artist.name; });
		});
		
	d3.select('#graph').on('click', function () {
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
		
		Player.stop();
		if (playController)
			playController.pause();
		setCursor(data.weeks[i], 'loading');
		
		playController = new Interrupt();
		play(i, playController);
		setTimeout(function () {
			playController.pause();
		}, 10000);
	});
		
	var playController = false;
	
	var cursor = d3
		.select('#cursor')
		.style('height', (chartHeight + paddingAxis) + 'px')
		.style('top', (paddingTop - paddingAxis) + 'px');
	function setCursor(week, state) {
		cursor
			.classed('loading', state === 'loading')
			.classed('playing', !!week);
		if (week)
			cursor.style('left', yearScale((week.from + week.to) / 2) + 'px');
	}
	Player.onstatechange = function (info) {
		setCursor(info && info.week);
		console.log(info ? info.trackName + ' - ' + info.artist : '');
	};
	
	function play(weekNumber, interrupt) {
		var week = data.weeks[weekNumber];
		if (!week)
			return;

		return lastfm({
			'method': 'user.getweeklytrackchart', 
			'user': user,
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
				var trackName = track['name'];
				var artist = track['artist']['#text'];
				promise = promise
					.then(function () {
						return spotify('search', {
							'type': 'track',
							'q': 'track:' + trackName + ' artist:' + artist,
							'limit': 1
						});
					})
					.then(interrupt)
					.then(function (result) {
						var results = result['tracks']['items'];
						if (results.length && interrupt.running)
							Player.push(results[0]['preview_url'], {
								week: week,
								trackName: trackName,
								artist: artist
							});
					})
					.then(interrupt)
					.catch(function () {});
			});
			return promise;
		})
		.catch(function () {})
		.then(function () {
			return play(weekNumber + 1, interrupt);
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
	var self = {};
	var stopDuration = 500;
	var startDuration = 750;
	
	// Fade a song in/out.
	function fade(audio, from, to, duration) {
		return new Promise(function (resolve) {
			var scale = d3.scale.linear().domain([0, duration]).range([from, to]).clamp(true);
			d3.timer(function (t) {
				audio.volume = scale(t);
				if (t > duration) {
					resolve();
					return true;
				}
				return false;
			});
		});
	}
	
	var current = false;
	var queue = [];
	self.play = function () {
		if (current) {
			fade(current, 0, 1, startDuration);
			current.play();
		}
	}
	self.next = function () {
		if (current)
			fade(current, 1, 0, stopDuration).then(current.pause.bind(current));
		current = queue.shift();
		self.onstatechange(current && current.info);
	}
	self.stop = function () {
		queue = [];
		self.next();
	}
	self.push = function (src, info) {
		var audio = new Audio();
		audio.ontimeupdate = function () {
			// To do: what if the audio pauses automatically to buffer?
			if (audio.ended || audio.currentTime + 2*stopDuration/1000 > audio.duration || (audio.currentTime > 5 && queue.length)) {
				audio.ontimeupdate = null;
				self.next();
				self.play();
			}
		};
		audio.preload = 'auto';
		audio.src = src;
		audio.info = info;
		queue.push(audio);
		
		if (!current) {
			self.next();
			self.play();
		}
	}

	self.onstatechange = function () {};
	
	return self;
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
	draw(processData(JSON.parse(localStorage.lastfmdata)));
};