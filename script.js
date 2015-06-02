/*
To-do:
 - Speed of filtering and sorting
 - Implement maximum size?
 
 - Now playing indicator
 - Improve UI
 - Interrupt loading when choosing a different user
 - Better cleanup of Timescape
 - Write readme and release!
 
 - Increase play duration when tab is not active?
 - If the player runs out of audio, change back to the loading cursor
*/

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
			//setTimeout(reject, 8000);
			
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
		week.totalPlays = d3.sum(week.artists.map(function (artist) { return +artist['playcount']; }));
		week.extent = d3.extent(week.artists.map(function (artist) { return +artist['playcount']; })); 
		
		week.artists = week.artists.map(function (artist, rank) {
			var key = artist['name'].replace('œ', 'oe'); // This is to solve a one-off case in my data ;)
			// Create a new entry for this artist if it doesn't exist.
			if (!artists[key]) {
				artists[key] = {
					name: artist['name'],
					url: artist['url'],
					plays: {},
					playWeeks: [],
					
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
			artists[key].playWeeks.push(week.from);
			
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
				
			return artists[key];
		});
	});
	
	artists = d3.values(artists);
	
	// Chop off artists with basically no plays, as an optimization.
	artists = artists.filter(function (artist) {
		return artist.totalPlays >= 3;
	})
	
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

function Timescape(startDate, endDate) {
	var self = this;
	var timeline = d3.select('#timeline');
	var cursor = d3.select('#cursor');
	var container = d3.select('#container');
	var chartHeight, plotWidth, totalHeight, yearScale;
	
	self.init = function () {
		timeline.selectAll('g.axis').remove();
		timeline.selectAll('g.artist').remove();
		container.style('display', '');
		cursor.transition().delay(750).duration(1000).style('opacity', 1);
		
		chartHeight = self.metrics.rows * self.metrics.rowHeight;
		plotWidth = self.metrics.width - self.metrics.artistWidth;
		totalHeight = self.metrics.paddingTop + self.metrics.yearHeight + chartHeight;
		yearScale = d3.time.scale.utc()
			.domain([startDate, endDate])
			.range([0, plotWidth]);
	};
	
	self.hide = function () {
		container.style('display', 'none');
		cursor.style('opacity', 0);
	};
	self.metrics = {
		artistWidth: 150,
		paddingTop: 70,
		yearHeight: 30,
		rowHeight: 17,
		width: 800,
		rows: 35,
		plotScale: 0.5
	};
	
	self.init();
	
	self.drawAxes = function () {
		timeline
			.attr('width', self.metrics.width)
			.attr('height', totalHeight);
		
		cursor
			.style('height', (chartHeight + self.metrics.yearHeight) + 'px')
			.style('top', self.metrics.paddingTop + 'px');
	
		d3.select('#plot')
			.style('width', plotWidth + 'px')
			.style('top', self.metrics.paddingTop + 'px');
		
		// Year labels.
		timeline.append('g').attr('class', 'axis')
			.attr('transform', 'translate(0,' + self.metrics.paddingTop + ')')
			.transition()
			.call(
				d3.svg.axis()
					.scale(yearScale)
					.orient('top')
					.ticks(d3.time.year.utc, 1)
					.tickSize(-(chartHeight + self.metrics.yearHeight), 0)
					.tickFormat(function (yearDate) {
						// Only show the year if there's enough room
						if (plotWidth - yearScale(yearDate) < 45)
							return '';
						return yearDate.getUTCFullYear();
					})
			);
	}

	var path = d3.svg.line()
		.x(function (plays) { return yearScale(plays[0]); })
		.y(function (plays) { return -self.metrics.plotScale * plays[1]; })
		.interpolate('basis');
	
	self.drawArtists = function (artists) {	
		var rows = timeline.selectAll('g.artist:not(.removed)')
			.data(artists, function (artist) { return artist.name; });
		
		// Remove rows.
		rows.exit()
			.classed('removed', true)
			.call(function (toRemove) {
				// Wait for the CSS transition to finish, and then make sure the elements are still set to be removed.
				delay(750).then(function () {
					toRemove.filter(function () { return this.classList.contains('removed'); }).remove();
				});
			})
			
		// Add rows.
		rows.enter()
			.append(function (artist) {
				return artist.el || document.createElementNS('http://www.w3.org/2000/svg', 'g');
			})
			.classed('artist', true)
			.classed('removed', false)
			.style('opacity', 0)
			.call(setTransform) // Set opacity and transform so it fades in the right spot.
			.filter(function (artist) { return !artist.el; })
			.each(function (artist) { artist.el = this; }) // Cache the element.
			.call(function (addedRows) {
				// Artist plots.
				addedRows.append('svg:path')
					.attr('d', function (artist) { return path(artist.points); })
					.attr('fill', function (artist, artistNumber) {
						return 'hsla(' + (Math.floor(artistNumber * 31 % 360)) + ', 100%, 80%, 0.7)';
					})
						
				// The artist text.
				addedRows.append('svg:text')
					.attr('x', plotWidth)
					.text(function (artist) { return artist.name; })
				
				// To-do: Add a now playing indicator?
			})
			
		rows.order();
		
		// Set every row to their correct position and opacity (after a delay, for the CSS transition to take effect).
		delay(0).then(function () {
			rows
				.style('opacity', function (artist) { return artist.relevance; })
				.call(setTransform);
		});
	}
	
	function setTransform(rows) {
		rows.style('transform', function (artist, artistNumber) {
			var position = self.metrics.paddingTop + self.metrics.yearHeight + self.metrics.rowHeight * artistNumber;
			return 'translate(0, ' + position + 'px)';
		});
	}
		
	self.drawCursor = function (date, state, shouldTransition) {
		cursor
			.classed('playing', !!date)
			.classed('loading', state === 'loading')
			.classed('seeking', state === 'seeking');
		if (date)
			(shouldTransition ? cursor.transition().duration(200) : cursor)
				.style('left', yearScale(date) + 'px');
	};
	
	function mouseToDate(container) {
		var x = d3.mouse(container)[0];
		if (x < 0)
			return startDate;
		if (x > plotWidth)
			return endDate;
		return yearScale.invert(x);
	}
	
	self.onDateSeek = function (date) {};
	self.onDateSelect = function (date) {};
	d3.select('#plot')
		.call(
			d3.behavior.drag()
				.on('dragstart', function () {
					d3.event.sourceEvent.stopPropagation();
					self.onDateSeek(mouseToDate(this));
				})
				.on('drag', function () {
					d3.event.sourceEvent.stopPropagation();
					self.onDateSeek(mouseToDate(this));
				})
				.on('dragend', function () {
					d3.event.sourceEvent.stopPropagation();
					self.onDateSelect(mouseToDate(this));
				})
		);
	d3.select('#plot')
		.on('click', function () {
			d3.event.preventDefault();
			d3.event.stopPropagation();
		});
}

function draw(data) {
	var artists = data.artists;
	var weeks = data.weeks;
	
	// No data!
	if (weeks.length === 0)
		return;
	
	var user = weeks[0].user;
	var startDate = weeks[0].from;
	var endDate = weeks[weeks.length - 1].to;
	
	var loader = new WeeklyTrackLoader(user);
	var player = new Player();
	var timescape = new Timescape(startDate, endDate);	
	
	function renderAll() {
		var usableHeight = 0.9 * (window.innerHeight - document.querySelector('form').clientHeight);
		timescape.metrics.width = 0.9 * window.innerWidth;
		timescape.metrics.rows = Math.floor((usableHeight - timescape.metrics.paddingTop) / timescape.metrics.rowHeight);
		
		// I want 10% of the peaks to be over 120 pixels tall.
		timescape.metrics.plotScale = 120 / d3.quantile(chooseArtists().map(function (a) { return a.maxPlays; }).sort(d3.ascending), 0.9);
		
		timescape.init();
		timescape.drawAxes();
		timescape.drawCursor(currentWeek && (currentWeek.from + currentWeek.to) / 2, currentCursorState);
		timescape.drawArtists(chooseArtists(currentWeek));
	}
	
	// Handle week selections.
	var currentWeek = false;
	var currentCursorState = false;
	var redrawRequest = false;
	document.body.onclick = function () {
		loader.stop();
		player.stop();
		selectWeek();
	};
	timescape.onDateSeek = function (date) {
		selectWeek(dateToWeek(date), 'seeking');
	};
	timescape.onDateSelect = function (date) {	
		loader.stop();
		player.stop();
		recentlyChosen = [];
		
		var week = dateToWeek(date);
		selectWeek(week, 'loading');
		loader.load(week);
	};
	player.onStateChange = function (info) {
		if (currentCursorState !== 'seeking')
			selectWeek(info && info.week);
	};
	function selectWeek(week, state) {
		if (week !== currentWeek || state !== currentCursorState) {
			currentWeek = week;
			currentCursorState = state;
			
			cancelAnimationFrame(redrawRequest);
			redrawRequest = requestAnimationFrame(function () {
				timescape.drawCursor(currentWeek && (currentWeek.from + currentWeek.to) / 2, state, !state);
				timescape.drawArtists(chooseArtists(currentWeek));
			});
		}
	}
	function dateToWeek(date) {
		// Find the closest week to the one clicked.
		var week = weeks[0];
		while (week && week.to <= +date)
			week = week.next;
		return week || weeks[weeks.length - 1];
	}
		
	// Handle loading tracks.
	loader.chooseTracks = chooseTracks;
	loader.onTrackLoaded = function (track) {
		var playDuration = 5000 + 7000 * Math.max(0, track.importance);
		return player.push(track.spotify['preview_url'], playDuration, track);
	};
	loader.shouldContinue = function () {
		// Throttle downloads once we get enough.
		return player.getQueueLength() < 9;
	};
	
	// Rerender on resize.
	var resizeTimeout = false;
	window.onresize = function () {
		timescape.hide();
		clearTimeout(resizeTimeout);
		resizeTimeout = setTimeout(renderAll, 400);
	};
	
	// Chooses which artists to play.
	var artistChoices = {};
	function chooseArtists(currentWeek) {
		if (artistChoices[currentWeek && currentWeek.from])
			var selection = artistChoices[currentWeek && currentWeek.from];
		
		// This part is quite slow; that's why we memoize!
		else {
			var selection = artists.slice();
			
			// Pick the most important
			if (currentWeek) {
				selection.forEach(function assignScore(artist) {
					var score = 4 * (1 + (artist.plays[currentWeek.from] / currentWeek.totalPlays || 0));
					for (var i = 0; i < artist.playWeeks.length; i++) {
						var day = 24 * 60 * 60 * 1000;
						var week = artist.playWeeks[i];
						var d = week - currentWeek.from;
						score += artist.plays[week] * (
							5 * normal(d / (28 * day)) +
							0.5 * normal(d / (365 * day))
						);
					};
					artist.score = score;
				});
				selection.sort(function sortByScore(a1, a2) { return -(a1.score - a2.score); });
			} else
				selection.sort(function (a1, a2) { return -(a1.totalPlays - a2.totalPlays); });
			selection = artistChoices[currentWeek && currentWeek.from] = selection.slice(0, timescape.metrics.rows);
		}
	
		if (currentWeek)
			var relevanceScale = d3.scale.log().clamp(true).domain(currentWeek.extent).range([0.2, 1]);
		
		// Add some information needed to render the artist.
		selection.forEach(function augmentArtist(artist) {
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
	
			// Find the first week with above-average number of plays.
			// To-do: improve this.
			if (!artist.firstPeakWeek) {
				var averagePlays = d3.mean(d3.values(artist.plays));
				artist.firstPeakWeek = d3.min(
					points.filter(function (point) { return point[1] >= averagePlays; }),
					function (point) { return point[0]; }
				) + Math.random(); // So that sorting is stable.
			}
		});
		
		return selection.sort(function sortByDate(a1, a2) { return -(a1.firstPeakWeek - a2.firstPeakWeek); });
	}	
	
	function normal(x) {
		return Math.exp(-Math.abs(x)) / 2;
	}
	
	// Chooses which tracks to play.
	var recentTracks = [];
	function chooseTracks(tracks) {
		// Calculate the number of times each artist was played this week.
		var artistPlays = {};
		for (var i = 0; i < tracks.length; i++) {
			var track = tracks[i];
			if (!artistPlays[track.artist])
				artistPlays[track.artist] = 0;
			artistPlays[track.artist] += track.plays;
		}
		
		// Filter songs that have already been played (we only need 4, so stop at 4).
		var chosen = [];
		for (var i = 0; i < tracks.length && chosen.length < 4; i++) {
			var track = tracks[i];
			if (recentTracks.every(function (playedTrack) { return track.trackName !== playedTrack.trackName; })) {
				chosen.push(track);
				
				// While we're at it...
				track.artistPlays = artistPlays[track.artist];
			}
		}
		
		
		chosen.sort(function (t1, t2) {
			return d3.descending(t1.artistPlays, t2.artistPlays) || d3.descending(t1.plays, t2.plays);
		});
		
		// We will choose a song if its play count or artist play count falls in a certain range of play counts.
		// The range is determined by the min and max play counts out of the previous 6 chosen tracks. We always
		// want to include the top song of the current week, so we always extend the range to include the top song
		// this week. If this is the first week we're choosing tracks for, instead use the top three tracks to
		// determine the range. Finally, scale the interval [min, max] to [0, 1], and call the value "importance."
		// I'm not extremely happy with the algorithm, but it gets the job done.
		var domain = recentTracks.length >= 3 ? recentTracks.slice(-6).concat(chosen.slice(0, 1)) : chosen.slice(0, 2);
		var artistImportanceScale = getImportanceScale(domain, function (track) { return track.artistPlays; });
		var importanceScale = getImportanceScale(domain, function (track) { return track.plays; });
		
		//console.log(importanceScale.domain(), artistImportanceScale.domain())
		
		chosen = chosen.filter(function (track) {
			track.artistImportance = artistImportanceScale(track.artistPlays);
			track.importance = importanceScale(track.plays);
			
			/*console.log(track.trackName + ' - ' + track.artist + ' (' + [Math.floor(10000 * track.importance), Math.floor(10000 * track.artistImportance)] + ') '
					+ '  ' + track.plays + ' plays, ' + track.artistPlays + ' artist plays'
				)
			*/	
			// Choose the songs that fall within the interval. This app is about artists, so ignore all but the REALLY frequently played songs!
			return track.importance >= 0.5 || track.artistImportance >= 0;
		});
		
		recentTracks = recentTracks.concat(chosen).slice(-24);
		return chosen;
		
		// To-do: It's annoying when it prematurely exhausts an artist before its peak
	};
	function getImportanceScale(domain, accessor) {
		var extent = d3.extent(domain, accessor);
		if (extent[0] === extent[1])
			extent[1] += 1; // Edge case, when the range has zero width
		return d3.scale.linear().domain(extent);
	}
	
	// Ready to render!
	renderAll();
}

function WeeklyTrackLoader(user) {
	var self = this;
	var currentInterrupt = new Interrupt();
	
	// Supposed to be overridden.
	self.chooseTracks = function (tracks) {
		return tracks.slice(0, 3).reverse();
	};
	self.onTrackLoaded = function (track) {};
	
	self.shouldContinue = function () { return true; };
	setInterval(function () {
		if (self.shouldContinue())
			currentInterrupt.resume();
		else
			currentInterrupt.pause();
	}, 1000);
	
	self.stop = function () {
		currentInterrupt.pause();
		currentInterrupt = new Interrupt();
	};
	
	// To-do: what if this doesn't load in time to play?
	self.load = function (week, interrupt) {
		if (!week)
			return;
		
		var interrupt = currentInterrupt;
		return lastfm({
			'method': 'user.getweeklytrackchart', 
			'user': user,
			'from': week.from / 1000,
			'to': week.to / 1000
		})
		.then(interrupt)
		.then(function (chart) {
			if (!chart || !chart['weeklytrackchart']['track'])
				return;
				
			// If only Last.fm had a sensible API...
			if (!(chart['weeklytrackchart']['track'] instanceof Array))
				chart['weeklytrackchart']['track'] = [chart['weeklytrackchart']['track']];
					
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
			return self.load(week.next, currentInterrupt);
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
				blocked.push(function () { resolve(value); });
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

// Okay, okay, this is very very silly. Browsers throttle setTimeout
// when the tab is inactive. This makes fading audio in and out very
// choppy when the tab is inactive... this is a silly workaround using
// the Web Audio API which isn't throttled -- for this exact reason.
// By the way, we can't use the Web Audio API to *play* the audio because
// of cross-domain restrictions.
var setTimeout2 = (function () {
	var fns = [];
	var context = new AudioContext();
	var source = context.createBufferSource();
	var node = context.createScriptProcessor(2048, 1, 1);
	node.onaudioprocess = function (e) {
		fns = fns.filter(function (fn) {
			return !fn(Date.now() - fn.t);
		});
	};
	source.connect(node);
	node.connect(context.destination);
	window.do_not_garbage_collect = [context, source, node];
		
	return function (fn) {
		fn.t = Date.now();
		fns.push(fn);
	};
}());

function Player() {
	var self = this;
	var stopDuration = 500;
	var startDuration = 750;
	
	// Fade a song in/out.
	function fade(audio, from, to, duration) {
		return new Promise(function (resolve) {
			var scale = d3.scale.linear().domain([0, duration]).range([from, to]).clamp(true);
			setTimeout2(function (t) {
				audio.volume = scale(t);
				if (t > duration) {
					resolve();
					return true;
				}
			});
		});
	}
	
	var current = false;
	var queue = [];
	self.next = function () {
		if (current)
			current.end();
		current = queue.shift();
		if (current)
			current.play();
		else
			self.onStateChange();
	};
	self.stop = function () {
		if (current)
			current.end();
		while (queue.length)
			queue.pop().end();
		current = false;
	};
	self.push = function (src, playDuration, info) {
		playDuration = playDuration || 5000;
		return new Promise(function (resolve, reject) {
			var audio = new Audio();
			var started = false;
			var ended = false;
			
			// Use this function to stop audio, to avoid any race conditions.
			audio.end = function () {
				if (ended)
					return;
				
				ended = true;
				fade(current, 1, 0, stopDuration).then(function () {
					audio.pause();
					
					// Kill download
					audio.src = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAVFYAAFRWAAABAAgAZGF0YQAAAAA=';
					audio.load();
				});
			};
			
			audio.volume = 0;
			audio.onprogress = function () {
				if (ended)
					return;
				
				var downloaded = audio.buffered.length && audio.buffered.end(audio.buffered.length - 1);
				if (downloaded > playDuration / 1000) {
					audio.loaded = true;
					resolve();
				
					// Here, we would stop downloading if there was an API to :(
				}
			};
			audio.onerror = reject;
			audio.ontimeupdate = function () {
				if (ended)
					return;
			
				if (audio.currentTime > 0 && !started) {
					started = true;
					fade(current, 0, 1, startDuration);
					self.onStateChange(info);
				}
			
				if (
					(audio.currentTime >= audio.duration - 2 * stopDuration / 1000) || 
					(audio.currentTime >= playDuration / 1000 && queue.length && queue[0].loaded)
				) {
					self.next();
				}
			};
			
			// This url fragment (sometimes) stops the browser from downloading the entire audio file.
			audio.src = src + '#t=0,' + (1 + playDuration / 1000);
			audio.preload = 'auto';
			
			// This is a hack: the #t=0,10 url fragment automatically pauses 
			// the audio 10 seconds in. This restarts it...
			audio.onpause = function () {
				if (!ended && audio.currentTime !== audio.duration)
					audio.play();
			};
			
			audio.info = info;
			queue.push(audio);
		})
		.then(function () {
			if (!current)
				self.next();
		});
	};
	self.getQueueLength = function () {
		return queue.length;
	};
	
	self.onStateChange = function (current) {};
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
	
	document.querySelector('form').onsubmit = function () {
		var user = document.querySelector('#user').value;
		window.location.hash = '#' + user;
		return false;
	};
	
	var container = document.querySelector('#container');
	var svg = document.querySelector('#timeline');
	window.onhashchange = function () {
		var user = window.location.hash.replace(/^#/, '');
		if (user) {
			document.querySelector('#user').value = user;
			document.querySelector('#go').disabled = true;
			load(user).then(function (data) {
				document.querySelector('#go').disabled = false;
				
				container.removeChild(document.querySelector('#timeline'));
				container.appendChild(svg.cloneNode(true));
				draw(processData(data));
			}).catch(function () {});
		}
	};
	
	window.onhashchange();

	// Set a default.
	if (!window.location.hash.replace(/^#/, '')) {
		document.querySelector('#user').focus();
		document.querySelector('#user').value = 'obscuresecurity';
	}
};