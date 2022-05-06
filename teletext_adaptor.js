"use strict";

import * as utils from './utils.js';

const TELETEXT_IRQ = 5;
const TELETEXT_FRAME_SIZE = 860;
const TELETEXT_UPDATE_FREQ = 50000;

export function TeletextAdaptor(cpu, scheduler) {
	var self = this;
	this.cpu = cpu;
	this.scheduler = scheduler;
	this.teletextStatus = 0x0f; /* low nibble comes from LK4-7 and mystery links which are left floating */
	this.teletextInts = false;
	this.teletextEnable = false;
	this.channel = 0;
	this.currentFrame = 0;
	this.rowPtr = 0x00;
	this.colPtr = 0x00;
	this.frameBuffer = new Array(16).fill(0).map(() => new Array(64).fill(0));
	
	this.poll = function () {
		if(self.cpu.resetLine)
		{
			self.update();
			self.pollTask.reschedule(TELETEXT_UPDATE_FREQ);
		}
	};
	this.pollTask = this.scheduler.newTask(this.poll);
	
	this.init = function() {
		console.log('Teletext adaptor: initialisation');
		this.reset();
		this.loadChannelStream(this.channel);
	}

	this.reset = function() {
		this.pollTask.ensureScheduled(true, TELETEXT_UPDATE_FREQ);
	};

	this.loadChannelStream = function(channel) {
		console.log('Teletext adaptor: switching to channel ' + channel)
		utils.loadData('teletext/txt' + channel + '.dat').then(function (data) {
			self.streamData = data;
			self.totalFrames = data.length / TELETEXT_FRAME_SIZE;
			self.currentFrame = 0;
			}
		)};

	this.read = function(addr) {
		var data = 0x00;
	
		switch (addr)
		{
			case 0x00:          // Status Register
				data = this.teletextStatus;
				break;
			case 0x01:          // Row Register
				break;
			case 0x02:          // Data Register
				data = this.frameBuffer[this.rowPtr][this.colPtr++];
				break;
			case 0x03:
				this.teletextStatus &= ~0xD0;       // Clear INT, DOR, and FSYN latches
				this.cpu.interrupt &= ~(1 << TELETEXT_IRQ);
				break;
		}

		return data;
	}

	this.write = function(addr, value) {
		switch (addr)
		{
			case 0x00:
				// Status register
				this.teletextInts = (value & 0x08) == 0x08;
				if (this.teletextInts && (this.teletextStatus & 0x80))
				{
					this.cpu.interrupt |= (1 << TELETEXT_IRQ); // Interrupt if INT and interrupts enabled
				}
				else
				{
					this.cpu.interrupt &= ~(1 << TELETEXT_IRQ); // Clear interrupt
				}
				this.teletextEnable = (value & 0x04) == 0x04;
				if ((value & 0x03) != this.channel && this.teletextEnable)
				{
					this.channel = value & 0x03;
					this.loadChannelStream(this.channel);
				}
				break;

			case 0x01:
				this.rowPtr = value;
				this.colPtr = 0x00;
				break;

			case 0x02:
				this.frameBuffer[this.rowPtr][this.colPtr++] = value & 0xFF;
				break;

			case 0x03:
				this.teletextStatus &= ~0xD0; // Clear INT, DOR, and FSYN latches
				this.cpu.interrupt &= ~(1 << TELETEXT_IRQ); // Clear interrupt
				break;
		}
	}

	this.update = function() {
		if (this.currentFrame >= this.totalFrames)
		{
			this.currentFrame = 0;
		}

		var offset = (this.currentFrame * TELETEXT_FRAME_SIZE) + (3 * 43);

		this.teletextStatus &= 0x0F;
		this.teletextStatus |= 0xD0;       // data ready so latch INT, DOR, and FSYN

		if(this.teletextEnable)
		{
			for(var i = 0; i < 16; ++i)
			{
				if(this.streamData[offset + (i * 43)] != 0)
				{
					this.frameBuffer[i][0] = 0x67;
					for(var j = 1; j <= 42; j++)
					{
						this.frameBuffer[i][j] = this.streamData[offset + ((i * 43) + (j-1))];
					}
				}
				else
				{
					this.frameBuffer[i][0] = 0x00;
				}
			}
		}

		this.currentFrame++;
		
		this.rowPtr = 0x00;
		this.colPtr = 0x00;

		if (this.teletextInts)
		{
			this.cpu.interrupt |= 1 << TELETEXT_IRQ;
		}
	}

}
