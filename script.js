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
			script.onerror = reject;
			script.src = 'http://ws.audioscrobbler.com/2.0/?' + stringify(obj);
			document.body.appendChild(script);
		});
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

function go(user, progress) {
	return Promise.all([
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
			progress
		);
	});
}

function processData(data) {
	var weeks = data
		// Remove empty weeks.
		.filter(function (week) { return week && !week['error'] && week['weeklyartistchart']; })
	
		// Normalize the data, as Last.fm is really, really inconsistent...
		.map(function (week) {
			var rec = week['weeklyartistchart'];			
			if (!rec['artist'])			
				return {
					user: rec['user'],
					from: 1000 * rec['from'],
					to: 1000 * rec['to'],
					artists: []
				};
			
			return {
				user: rec['@attr']['user'],
				from: 1000 * rec['@attr']['from'],
				to: 1000 * rec['@attr']['to'],
				artists: 
					rec['artist'] instanceof Array
						? week['weeklyartistchart']['artist']
						: [week['weeklyartistchart']['artist']]
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
					topRank: Infinity,
					playFrequency: 0
				};
			}
			
			// Update info.
			var plays = artists[key].plays[week.from] = +artist['playcount'];
			
			// Update summary statistics.
			artists[key].totalPlays += plays;
			if (plays > artists[key].maxPlays) {
				artists[key].maxPlays = plays;
				artists[key].maxWeek = week.from + Math.random(); // So that sorting by maxWeek is stable
			}
			if (artists[key].startWeek === null)
				artists[key].startWeek = week.from;
			artists[key].playFrequency += plays / (Date.now() - artists[key].startWeek);
			if (rank < artists[key].topRank)
				artists[key].topRank = rank;
		});
	});
	
	artists = d3.values(artists);
	
	// Chop off the first 1% of weeks (with data), to remove extreme outliers.
	var firstPercentileDate = d3.quantile(
		artists.map(function (artist) { return artist.startWeek; }).sort(d3.ascending), 
		0.01
	);
	while (weeks.length && weeks[0].from < firstPercentileDate) 
		weeks.shift();
	
	// Make weeks a linked list.
	for (var i = 0; i < weeks.length; i++) {
		weeks[i].prev = weeks[i - 1];
		weeks[i].next = weeks[i + 1];
	}
	
	return {
		artists: artists,
		weeks: weeks
	};
}

function Timescape(startDate, endDate, metrics) {
	var self = this;
	
	var chartHeight = metrics.rows * metrics.rowHeight;
	var totalWidth = metrics.plotWidth + metrics.artistWidth;
	var totalHeight = metrics.paddingTop + chartHeight;
	
	var timeline = d3
		.select('#timeline')
		.attr('width', totalWidth)
		.attr('height', totalHeight);
	
	var yearScale = d3.time.scale.utc()
		.domain([startDate, endDate])
		.range([0, metrics.plotWidth]);
	
	// Year labels.
	timeline
		.append('g')
		.attr('class', 'axis')
		.attr('transform', 'translate(0,' + (metrics.paddingTop - metrics.yearHeight) + ')')
		.transition()
		.call(
			d3.svg.axis()
				.scale(yearScale)
				.orient('top')
				.ticks(d3.time.year.utc, 1)
				.tickSize(-(chartHeight + metrics.yearHeight), 0)
				.tickFormat(function (yearDate) {
					// Only show the year if there's enough room
					if (metrics.plotWidth - yearScale(yearDate) < 30)
						return '';
					return yearDate.getUTCFullYear();
				})
		);

	var line = d3.svg.line()
		.x(function (plays) { return yearScale(plays[0]); })
		.y(function (plays) { return -metrics.plotScale * plays[1]; })
		.interpolate('basis');
	
	self.drawArtists = function (artists) {	
		var rows = timeline.selectAll('g.artist:not(.removed)')
			.data(artists, function (artist) { return artist.name; });
			
		// Remove rows.
		var toRemove = rows.exit().classed('removed', true).call(fadeOut);
		delay(750).then(function () { toRemove.remove() });
			
		// Add new rows.
		var addedRows = rows.enter().append('g').attr('class', 'artist').call(fadeOut);
		
		// Add artist plots.
		addedRows
			.append('path')
			.attr('fill', function (artist, artistNumber) {
				return 'hsla(' + (Math.floor(artistNumber * 31 % 360)) + ', 100%, 80%, 0.7)';
			})
			.attr('d', function (artist) { return line(artist.points); });
				
		// The artist text.
		addedRows
			.append('text')
			.attr('x', metrics.plotWidth)
			.text(function (artist) { return artist.name; });
		
		// Move updated rows to their correct position.
		rows.order();
		delay(0).then(function () { fadeIn(rows); });
	}

	function fadeOut(rows) {
		rows
			.style('opacity', 0)
			.style('transform', function (artist, artistNumber) {
				var position = metrics.paddingTop + metrics.rowHeight * artistNumber;
				var t = 0.95;
				return 'translate(0, ' + ((1-t)*totalHeight + t*position) + 'px)';
			})
	}
	function fadeIn(rows) {
		rows
			.style('opacity', function (artist, artistNumber) { return artist.relevance; })
			.style('transform', function (artist, artistNumber) {
				var position = metrics.paddingTop + metrics.rowHeight * artistNumber;
				return 'translate(0, ' + position + 'px)';
			})
	}
	
	self.onTimeSelect = function (date) {};
	d3.select('#graph').on('click', function () {
		var x = d3.mouse(this)[0];
		if (x > metrics.plotWidth)
			return;
		self.onTimeSelect(yearScale.invert(x));
		return false;
	});
	
	var cursor = d3
		.select('#cursor')
		.style('height', (chartHeight + metrics.yearHeight) + 'px')
		.style('top', (metrics.paddingTop - metrics.yearHeight) + 'px');
	self.drawCursor = function (date, shouldTransition, isLoading) {
		cursor
			.classed('loading', isLoading)
			.classed('playing', !!date);
		if (date)
			(shouldTransition ? cursor : cursor.transition().duration(200))
				.style('left', yearScale(date) + 'px');
	};
}

function draw(data) {
	var artists = data.artists;
	var weeks = data.weeks;
	
	if (weeks.length === 0)
		throw new Error('No data!');
	
	var user = weeks[0].user;
	var startDate = weeks[0].from;
	var endDate = weeks[weeks.length - 1].to;
	
	// The state.
	var currentWeek = false;
	var currentLoadingState = false;
	var currentArtists = augmentArtists(chooseArtists());
	
	var timescape = new Timescape(startDate, endDate, {
		artistWidth: 130,
		paddingTop: 100,
		plotWidth: 800,
		yearHeight: 20,
		rowHeight: 13,
		rows: currentArtists.length,
		
		// I want 10% of the peaks to be over 120 pixels tall.
		plotScale: 120 / d3.quantile(currentArtists.map(function (a) { return a.maxPlays; }).sort(d3.ascending), 0.9)
	});
	timescape.drawCursor();
	timescape.drawArtists(currentArtists);
	
	var loader = new WeeklyTrackLoader(user);
	var player = new Player();
	var recentlyChosen = [];
	loader.onTrackLoaded = function (track) {
		player.push(track.spotify['preview_url'], track);
	};
	loader.chooseTracks = function (tracks) {
		// To-do: It's annoying when it prematurely exhausts an artist before its peak
	
		// Avoid songs that have been played.
		var choices = tracks.filter(function (track) {
			return recentlyChosen.indexOf(track.trackName) === -1;
		});
		
		// Take three songs.
		choices = choices.slice(0, 3);
		
		recentlyChosen = recentlyChosen.concat(choices.map(function (track) { return track.trackName; })).slice(-24);
		return d3.shuffle(choices);
	};
	
	// To-do: Play a variable amount of the song depending on how many plays it got.
	
	function selectWeek(week, loadingState) {
		if (week !== currentWeek || loadingState !== currentLoadingState) {
			currentWeek = week;
			currentLoadingState = loadingState;
			currentArtists = augmentArtists(chooseArtists());
			
			timescape.drawCursor(week && (week.from + week.to) / 2, !loadingState, loadingState);
			timescape.drawArtists(currentArtists);
		}
	}
	
	timescape.onTimeSelect = function (date) {
		// Find the closest week to the one clicked.
		var week = weeks[0];
		while (week && week.to <= +date)
			week = week.next;
			
		/*	
		clearInterval(window.interval);
		window.interval = setInterval(function () {
			if (week)
				selectWeek(week = week.next);
		}, 1500);
		return;
		*/
		
		loader.stop();
		player.stop(); // This causes a layout update, even though one is coming up four lines later :/
		
		selectWeek(week, true);
		loader.load(week);
		
		setTimeout(function () {
			// Uh, this doesn't seem to work
			loader.stop();
		}, 20000);
	};
	
	player.onStateChange = function (info) {
		selectWeek(info && info.week);
		console.log(info ? info.trackName + ' - ' + info.artist : '');
	};
	
	function chooseArtists() {
		if (currentWeek) {
			artists.forEach(function (artist, i) {
				artist.score = 
					4 * artist.playFrequency * 30 * 24 * 60 * 60 * 1000 +
					(3 * artist.plays[currentWeek.from] || 0) + 
					(2 * (currentWeek.next ? artist.plays[currentWeek.next.from] : artist.plays[currentWeek.from]) || 0) + 
					((currentWeek.next && currentWeek.next.next ? artist.plays[currentWeek.next.next.from] : artist.plays[currentWeek.from]) || 0) + 
					(2 * (currentWeek.prev ? artist.plays[currentWeek.prev.from] : artist.plays[currentWeek.from]) || 0) +
					((currentWeek.prev && currentWeek.prev.prev ? artist.plays[currentWeek.prev.prev.from] : artist.plays[currentWeek.from]) || 0)
				/*artist.score = artist.totalPlays + (
					artist.plays[currentWeek.from] * 3 + 
					(currentWeek.next ? artist.plays[currentWeek.next.from] : artist.plays[currentWeek.from]) + 
					(currentWeek.prev ? artist.plays[currentWeek.prev.from] : artist.plays[currentWeek.from])
				|| 0);*/
			});
			artists.sort(function (a1, a2) { return -(a1.score - a2.score); });
		} else
			artists.sort(function (a1, a2) { return -(a1.totalPlays - a2.totalPlays); });
	
		// To-do: choose to show artists based on e.g. what's currently playing
			//.filter(function (artist) { return artist.maxPlays > 30 || (artist.totalPlays > 300 && artist.maxPlays > 50) || artist.topRank < 2; })
		return artists.slice(0, 50).sort(function (a1, a2) { return -(a1.maxWeek - a2.maxWeek); });
	}
	
	// Calculate some extra values needed for rendering the artist.
	function augmentArtists(artists) {
	
		// Highlight the ones with the most plays this week.
		if (currentWeek) {
			var mostPlays = d3.max(artists, function (artist) { return artist.plays[currentWeek.from] || 0; });
			var relevanceScale = d3.scale.linear().domain([0, mostPlays]).range([0.2, 1]);
		}
		
		artists.forEach(function (artist) {
			artist.relevance = currentWeek ? relevanceScale(artist.plays[currentWeek.from] || 0) : 1;
			
			// Calculate a time series for this artist. (We only need to do this once.)
			if (!artist.points) {
				var points = artist.points = weeks.map(function (week) {
					return [(week.from + week.to) / 2, artist.plays[week.from] || 0];
				});
				points.unshift([startDate, 0])
				points.push([endDate, 0]);
				
				// Leave just one zero before the first non-zero point.
				while (points.length >= 2 && points[0][1] === 0 && points[1][1] === 0)
					points.shift();
			}
		});
		
		return artists;
	}
}

function WeeklyTrackLoader(user) {
	var self = this;
	var interrupt = new Interrupt();
	
	// Supposed to be overridden.
	self.chooseTracks = function (tracks) {
		return tracks.slice(0, 3).reverse();
	};
	self.onTrackLoaded = function (track) {};
	
	self.stop = function () {
		interrupt.pause();
		interrupt = new Interrupt();
	};
	
	self.load = function (week) {
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
					
			var promise = Promise.resolve();
			self.chooseTracks(
				chart['weeklytrackchart']['track'].map(function (track) {
					return {
						week: week,
						trackName: track['name'],
						plays: +track['playcount'],
						artist: track['artist']['#text'],
						lastfm: track
					};
				})
			).forEach(function (track) {
				promise = promise
					.then(function () {
						return spotify('search', {
							'type': 'track',
							'q': 'track:' + track.trackName + ' artist:' + track.artist,
							'limit': 1
						});
					})
					.then(interrupt)
					.then(function (result) {
						var results = result['tracks']['items'];
						if (results.length && interrupt.running) {
							track.spotify = results[0];
							return self.onTrackLoaded(track);
						}
					})
					.then(interrupt)
					.catch(function () {});
			});
			return promise;
		})
		.catch(function () {})
		.then(function () {
			return self.load(week.next);
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

function Player() {
	var self = this;
	var stopDuration = 500;
	var startDuration = 750;
	
	// Fade a song in/out.
	function fade(audio, from, to, duration) {
		return new Promise(function (resolve) {
			var scale = d3.scale.linear().domain([0, duration]).range([from, to]).clamp(true);
			var t = Date.now();
			(function step() {
				var dt = Date.now() - t;
				audio.volume = scale(dt);
				if (dt > duration)
					resolve();
				else
					setTimeout(step, 60);
			}());
		});
	}
	
	var current = false;
	var queue = [];
	self.play = function () {
		if (current) {
			// To do: start fade-in only when the audio has started
			fade(current, 0, 1, startDuration);
			current.play();
		}
	};
	self.next = function () {
		if (current)
			fade(current, 1, 0, stopDuration).then(current.pause.bind(current));
		current = queue.shift();
		self.onStateChange(current && current.info);
	};
	self.stop = function () {
		queue = [];
		self.next();
	};
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
		// audio.onerror = function () {} // How to deal with errors?
		audio.preload = 'auto';
		audio.src = src;
		audio.info = info;
		queue.push(audio);
		
		if (!current) {
			self.next();
			self.play();
		}
	};
	self.onStateChange = function (current, queue) {};
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
	document.querySelector('form').onsubmit = function () {
		var user = document.querySelector('#user').value;
		if (user) {
			document.querySelector('#go').disabled = true;
			localStorage.lastfmUser = user;
			load(user).then(function (data) {
				document.querySelector('#go').disabled = false;
				show(user, data);
			});
		}
		return false;
	};
	
	function load(user, localOnly) {
		if (localStorage['lastfm' + user])
			return Promise.resolve(JSON.parse(localStorage['lastfm' + user]));
		
		if (localOnly)
			return Promise.reject();
		
		var progress = d3.select('form')//.transition();
		return go(user, function (n, m) {
			var percentage = n / m * 100 + '%';
			progress.style('background', 'linear-gradient(90deg, #eee ' + percentage + '%, #f6f6f6 ' + percentage + '%)');
		}).then(function (data) {
			try {
				localStorage['lastfm' + user] = JSON.stringify(data);
			} catch (e) {} // Exceeded quota.
			
			progress.style('background', '');
			return data;
		});
	}
	
	var container = document.querySelector('#container');
	var svg = document.querySelector('#timeline');
	function show(user, data) {
		document.querySelector('#user').value = user;
		container.removeChild(document.querySelector('#timeline'));
		container.appendChild(svg.cloneNode(true));
		draw(processData(data));
	}

	if (localStorage.lastfmUser)
		load(localStorage.lastfmUser, true).then(function (data) {
			show(localStorage.lastfmUser, data);
		}).catch(function () {});
	else {
		document.querySelector('#user').focus();
		document.querySelector('#user').value = 'obscuresecurity';
	}
};