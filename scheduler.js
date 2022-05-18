"use strict";

var MaxHeadroom = 0xffffffff;

export function Scheduler() {
    this.scheduled = null;
    this.epoch = 0;
}

function Task(scheduler, onExpire) {
    this.scheduler = scheduler;
    this.prev = this.next = null;
    this.expireEpoch = 0;
    this.onExpire = onExpire;
    this._scheduled = false;
}

Scheduler.prototype.schedule = function (task, delay) {
    if (task.scheduler !== this) {
        throw new Error("Wrong scheduler for task, or non-task");
    }
    if (task.scheduled()) {
        throw new Error("Task is already scheduled");
    }

    var expireEpoch = delay + this.epoch;
    task.expireEpoch = expireEpoch;
    task._scheduled = true;

    var before = this.scheduled;
    var prev = null;
    while (before && before.expireEpoch <= expireEpoch) {
        prev = before;
        before = before.next;
    }
    task.next = before;
    task.prev = prev;
    if (task.next) task.next.prev = task;
    if (task.prev) {
        task.prev.next = task;
    } else {
        this.scheduled = task;
    }
};

Scheduler.prototype.cancel = function (task) {
    if (!task.scheduled()) return;
    if (!task.prev) {
        // First element, we need to update the head element.
        this.scheduled = task.next;
    } else {
        task.prev.next = task.next;
    }
    if (task.next) {
        task.next.prev = task.prev;
    }
    task.next = task.prev = null;
    task._scheduled = false;
};

Scheduler.prototype.polltime = function (ticks) {
    var targetEpoch = this.epoch + ticks;
    while (this.scheduled && this.scheduled.expireEpoch <= targetEpoch) {
        var head = this.scheduled;
        this.epoch = head.expireEpoch;
        head.cancel(); // cancel first
        head.onExpire(); // expiry may reschedule
    }
    this.epoch = targetEpoch;
};

Scheduler.prototype.headroom = function () {
    if (this.scheduled === null) return MaxHeadroom;
    return this.scheduled.expireEpoch - this.epoch;
};

Scheduler.prototype.newTask = function (onExpire) {
    return new Task(this, onExpire);
};

Task.prototype.scheduled = function () {
    return this._scheduled;
};

Task.prototype.schedule = function (delay) {
    this.scheduler.schedule(this, delay);
};

Task.prototype.reschedule = function (delay) {
    this.scheduler.cancel(this);
    this.scheduler.schedule(this, delay);
};

Task.prototype.cancel = function () {
    this.scheduler.cancel(this);
};

Task.prototype.ensureScheduled = function (state, delay) {
    if (state) {
        if (!this.scheduled()) this.schedule(delay);
    } else {
        this.cancel();
    }
};
