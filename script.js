function getShader(gl, id) {
	var shaderScript = document.getElementById(id);
	
	if (shaderScript.type == "x-shader/x-fragment")
		var shader = gl.createShader(gl.FRAGMENT_SHADER);
	else if (shaderScript.type == "x-shader/x-vertex")
		var shader = gl.createShader(gl.VERTEX_SHADER);
	else
		throw new Error("Invalid script tag!");
	
	gl.shaderSource(shader, shaderScript.text);
	gl.compileShader(shader);

	if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS))
		throw new Error(gl.getShaderInfoLog(shader));

	return shader;
}


var shaderProgram;

function initShaders() {
	var fragmentShader = getShader(gl, "shader-fs");
	var vertexShader = getShader(gl, "shader-vs");

	shaderProgram = gl.createProgram();
	gl.attachShader(shaderProgram, vertexShader);
	gl.attachShader(shaderProgram, fragmentShader);
	gl.linkProgram(shaderProgram);

	if (!gl.getProgramParameter(shaderProgram, gl.LINK_STATUS))
		alert("Could not initialise shaders");

	gl.useProgram(shaderProgram);
	shaderProgram.position = gl.getUniformLocation(shaderProgram, "position");
	shaderProgram.perspective = gl.getUniformLocation(shaderProgram, "perspective");
	shaderProgram.color = gl.getAttribLocation(shaderProgram, "aColor");
	shaderProgram.vertex = gl.getAttribLocation(shaderProgram, "vertex");
	gl.enableVertexAttribArray(shaderProgram.color);
	gl.enableVertexAttribArray(shaderProgram.vertex);
}

function drawScene() {
	var perspective = mat4.create();
	var position = mat4.create();

	gl.viewport(0, 0, gl.viewportWidth, gl.viewportHeight);
	gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

	//mat4.perspective(perspective, Math.PI / 2, 1, 0.1, 100.0);
	//mat4.translate(perspective, perspective, [0, -1, 0]);
	
	function draw(mode, vertices, colors) {
		gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
		gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(vertices), gl.STATIC_DRAW);		
		gl.vertexAttribPointer(shaderProgram.vertex, 3, gl.FLOAT, false, 0, 0);
		
		gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
		gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(colors), gl.STATIC_DRAW);
		gl.vertexAttribPointer(shaderProgram.color, 4, gl.FLOAT, false, 0, 0);
		
		gl.uniformMatrix4fv(shaderProgram.perspective, false, perspective);
		gl.uniformMatrix4fv(shaderProgram.position, false, position);
		gl.drawArrays(mode, 0, vertices.length / 3);
	}
	
	mat4.identity(position);
	mat4.translate(position, position, [-10, -10, -10.0]);
	for (var i = 0; i < 25; i++) {
		mat4.translate(position, position, [0, 0, -1.0]);
		var series = trianglesFromTimeSeries(generateTimeSeries()).slice(0, 1.5 * 20 / 0.05);
		var color = [Math.random(), Math.random(), Math.random(), 0.7];
		draw(gl.TRIANGLE_STRIP, flatten(series), flatten(series.map(function () { return color; })));
	}
	
	mat4.identity(position);
	mat4.translate(position, position, [0, 0, 0]);
	var series = [
		[-1, -1, 0],
		[1, -1, 0],
		[-1, -1, -10],
		[1, -1, -10],
	]
	draw(gl.TRIANGLE_STRIP, flatten(series), flatten(series.map(function () { return [Math.random() * 0.3 + 0.7, Math.random() * 0.3 + 0.7, Math.random() * 0.3 + 0.7, 1]; })));
}

function generateTimeSeries() {
	var offset = Math.random();
	var period = 75 * Math.random() + 75;
	var amplitude = 1 * Math.random() + 1;
	var noiseAmplitude = 0;
	var series = [];
	for (var i = 0; i < 3000; i++)
		series.push(amplitude * Math.pow(Math.sin(3.14 * i / period), 2) + offset + noiseAmplitude * Math.random());
	return series;
}

function trianglesFromTimeSeries(series) {
	var strip = [[0, 0, 0]];
	var step = 0.05;
	for (var i = 0; i < series.length; i++) {
		strip.push([step * i, series[i], 0]);
		strip.push([step * (i + 1), 0, 0]);
	}
	return strip;
}

function flatten(arr) {
	return Array.prototype.concat.apply([], arr);
}

var canvas = document.querySelector('canvas');
var gl = canvas.getContext('experimental-webgl', {premultipliedAlpha: false});
gl.viewportWidth = canvas.width;
gl.viewportHeight = canvas.height;

initShaders();

gl.clearColor(0.0, 0.0, 0.0, 1.0);
gl.enable(gl.DEPTH_TEST);

drawScene();