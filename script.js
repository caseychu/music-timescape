function generateTimeSeries() {
	var offset = Math.random();
	var period = 75 * Math.random() + 75;
	var amplitude = 1 * Math.random() + 1;
	var series = [];
	for (var i = 0; i < 300; i++)
		series.push(amplitude * Math.pow(Math.sin(3.14 * i / period), 2) + offset);
	return series;
}

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
]


window.onload = function () {
	var width = 600;
	var height = 200;
	var line = d3.svg.line()
		.x(function (d, i) { return i * 2; })
		.y(function (d, i) { return height - 50 * d; })
		.interpolate('step-before');

	var rows = d3
		.select('#timeline')
		.selectAll('tr')
		.data(data)
		.enter()
		.append('tr');
	
	rows.append('td')
		.append('svg')
		.attr('width', width)
		.attr('height', height)
		.append('path')
		.attr('d', function (artist) { return line([0].concat(artist.series, [0])); })
		.attr('stroke', '#A3C9B8')
		.attr('fill', '#D3F9E8');
	
	rows.append('td')
		.text(function (artist) { return artist.artist; })
};