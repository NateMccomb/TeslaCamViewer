/**
 * StatisticsManager - Calculates and displays event statistics
 * Shows event breakdowns, recording stats, top locations, trigger analysis,
 * timeline charts, and storage estimates
 */
class StatisticsManager {
    constructor() {
        this.modal = null;
        this.events = [];
    }

    /**
     * Set the events data for analysis
     * @param {Array} events - Array of parsed events from folderParser
     */
    setEvents(events) {
        this.events = events || [];
    }

    /**
     * Calculate all statistics from events
     * @returns {Object} Statistics object
     */
    calculateStats() {
        if (!this.events || this.events.length === 0) {
            return null;
        }

        const stats = {
            totalEvents: this.events.length,
            eventsByType: { saved: 0, sentry: 0, recent: 0 },
            totalRecordingTime: 0,
            totalClips: 0,
            averageEventLength: 0,
            triggerReasons: {},
            topLocations: {},
            sentryLocations: {},
            eventsByMonth: {},
            eventsByDay: {},
            sentryByHour: new Array(24).fill(0),
            earliestEvent: null,
            latestEvent: null
        };

        for (const event of this.events) {
            // Count by type (event.type is like 'SavedClips', 'SentryClips', 'RecentClips')
            let type = (event.type || 'RecentClips').toLowerCase().replace('clips', '');
            if (stats.eventsByType[type] !== undefined) {
                stats.eventsByType[type]++;
            }

            // Calculate recording time (estimate ~60s per clip)
            const clipCount = event.clipGroups?.length || 0;
            stats.totalClips += clipCount;
            const eventDuration = clipCount * 60; // Approximate
            stats.totalRecordingTime += eventDuration;

            // Track trigger reasons (check both event.reason and event.metadata.reason)
            const reason = event.reason || event.metadata?.reason;
            if (reason) {
                const normalizedReason = this.normalizeTriggerReason(reason);
                stats.triggerReasons[normalizedReason] = (stats.triggerReasons[normalizedReason] || 0) + 1;
            }

            // Track locations (check both event.city and event.metadata.city)
            const city = event.city || event.metadata?.city;
            if (city) {
                stats.topLocations[city] = (stats.topLocations[city] || 0) + 1;

                // Track sentry-specific locations
                if (type === 'sentry') {
                    stats.sentryLocations[city] = (stats.sentryLocations[city] || 0) + 1;
                }
            }

            // Track by date and hour
            if (event.timestamp) {
                const date = new Date(event.timestamp);
                const monthKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
                const dayKey = date.toISOString().split('T')[0]; // YYYY-MM-DD

                stats.eventsByMonth[monthKey] = (stats.eventsByMonth[monthKey] || 0) + 1;
                stats.eventsByDay[dayKey] = (stats.eventsByDay[dayKey] || 0) + 1;

                // Track sentry events by hour of day
                if (type === 'sentry') {
                    const hour = date.getHours();
                    stats.sentryByHour[hour]++;
                }

                // Track earliest/latest
                if (!stats.earliestEvent || date < new Date(stats.earliestEvent)) {
                    stats.earliestEvent = event.timestamp;
                }
                if (!stats.latestEvent || date > new Date(stats.latestEvent)) {
                    stats.latestEvent = event.timestamp;
                }
            }
        }

        // Calculate average
        stats.averageEventLength = stats.totalRecordingTime / stats.totalEvents;

        // Sort locations by count - top 10
        stats.topLocations = Object.entries(stats.topLocations)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 10);

        // Sort sentry locations - top 10
        stats.sentryLocations = Object.entries(stats.sentryLocations)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 10);

        return stats;
    }

    /**
     * Calculate storage estimate based on clip count
     * Tesla dashcam footage is approximately 100MB per 10 minutes of 4-camera recording
     * @param {number} totalClips - Total number of clips
     * @returns {Object} Storage estimate
     */
    calculateStorageEstimate(totalClips) {
        // ~100MB per 10 minutes = ~10MB per minute per 4 cameras
        // Each clip is ~60 seconds, so ~10MB per clip for all 4 cameras
        const estimatedMB = totalClips * 10;
        const estimatedGB = estimatedMB / 1024;

        return {
            mb: Math.round(estimatedMB),
            gb: estimatedGB.toFixed(2),
            displayValue: estimatedGB >= 1 ? `${estimatedGB.toFixed(1)} GB` : `${Math.round(estimatedMB)} MB`
        };
    }

    /**
     * Generate events-over-time data for chart (last 14 days)
     * @param {Object} eventsByDay - Object with day keys and event counts
     * @returns {Array} Array of chart data points
     */
    generateTimelineData(eventsByDay) {
        const data = [];
        const today = new Date();

        // Generate last 14 days
        for (let i = 13; i >= 0; i--) {
            const date = new Date(today);
            date.setDate(date.getDate() - i);
            const dayKey = date.toISOString().split('T')[0];
            const count = eventsByDay[dayKey] || 0;

            data.push({
                date: dayKey,
                label: date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
                count: count
            });
        }

        // Calculate max for percentage
        const maxCount = Math.max(...data.map(d => d.count), 1);
        data.forEach(d => {
            d.percent = (d.count / maxCount) * 100;
        });

        return data;
    }

    /**
     * Create timeline bar chart HTML
     * @param {Array} data - Timeline data array
     * @returns {string} HTML string
     */
    createTimelineChart(data) {
        if (!data || data.length === 0) {
            return '<p class="stats-empty">No timeline data available</p>';
        }

        const hasEvents = data.some(d => d.count > 0);
        if (!hasEvents) {
            return '<p class="stats-empty">No events in the last 14 days</p>';
        }

        return `
            <div class="stats-timeline-chart">
                ${data.map(d => `
                    <div class="stats-timeline-bar" title="${d.label}: ${d.count} events">
                        <div class="stats-timeline-fill" style="height: ${Math.max(d.percent, d.count > 0 ? 5 : 0)}%"></div>
                        <span class="stats-timeline-count">${d.count || ''}</span>
                    </div>
                `).join('')}
            </div>
            <div class="stats-timeline-labels">
                <span>${data[0].label}</span>
                <span>${data[Math.floor(data.length / 2)].label}</span>
                <span>${data[data.length - 1].label}</span>
            </div>
        `;
    }

    /**
     * Create time-of-day chart for sentry events
     * @param {Array} sentryByHour - Array of 24 hourly counts
     * @returns {string} HTML string
     */
    createTimeOfDayChart(sentryByHour) {
        const maxCount = Math.max(...sentryByHour, 1);
        const totalSentry = sentryByHour.reduce((a, b) => a + b, 0);

        if (totalSentry === 0) {
            return '<p class="stats-empty">No sentry events to analyze</p>';
        }

        // Color gradient from night (dark blue) to day (yellow) to night
        const getHourColor = (hour) => {
            // Night: 0-5, 19-23 = dark blue
            // Morning: 6-11 = orange to yellow
            // Afternoon: 12-17 = yellow to orange
            // Evening: 18 = orange
            if (hour >= 0 && hour < 6) return '#1a237e'; // Night
            if (hour >= 6 && hour < 9) return '#ff9800'; // Morning
            if (hour >= 9 && hour < 17) return '#ffc107'; // Day
            if (hour >= 17 && hour < 20) return '#ff9800'; // Evening
            return '#1a237e'; // Night
        };

        const bars = sentryByHour.map((count, hour) => {
            const percent = (count / maxCount) * 100;
            const color = getHourColor(hour);
            const label = hour === 0 ? '12am' : hour === 12 ? '12pm' : hour > 12 ? `${hour - 12}pm` : `${hour}am`;
            return `
                <div class="stats-hour-bar" title="${label}: ${count} events">
                    <div class="stats-hour-fill" style="height: ${Math.max(percent, count > 0 ? 5 : 0)}%; background: ${color}"></div>
                </div>
            `;
        }).join('');

        return `
            <div class="stats-hour-chart">
                ${bars}
            </div>
            <div class="stats-hour-labels">
                <span>12am</span>
                <span>6am</span>
                <span>12pm</span>
                <span>6pm</span>
                <span>12am</span>
            </div>
        `;
    }

    /**
     * Generate trends data for weekly or monthly view
     * @param {Object} eventsByDay - Object with day keys and event counts
     * @param {string} mode - 'weekly' or 'monthly'
     * @returns {Array} Array of trend data points
     */
    generateTrendsData(eventsByDay, mode = 'weekly') {
        const data = [];
        const today = new Date();

        if (mode === 'weekly') {
            // Last 12 weeks
            for (let i = 11; i >= 0; i--) {
                const weekEnd = new Date(today);
                weekEnd.setDate(weekEnd.getDate() - (i * 7));
                const weekStart = new Date(weekEnd);
                weekStart.setDate(weekStart.getDate() - 6);

                let count = 0;
                let savedCount = 0;
                let sentryCount = 0;

                // Count events in this week
                for (let d = 0; d <= 6; d++) {
                    const date = new Date(weekStart);
                    date.setDate(date.getDate() + d);
                    const dayKey = date.toISOString().split('T')[0];

                    if (eventsByDay[dayKey]) {
                        count += eventsByDay[dayKey];
                    }
                }

                data.push({
                    label: weekStart.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
                    count: count,
                    start: weekStart,
                    end: weekEnd
                });
            }
        } else {
            // Last 6 months
            for (let i = 5; i >= 0; i--) {
                const monthDate = new Date(today.getFullYear(), today.getMonth() - i, 1);
                const monthKey = monthDate.toISOString().slice(0, 7); // YYYY-MM
                const monthName = monthDate.toLocaleDateString('en-US', { month: 'short', year: '2-digit' });

                let count = 0;

                // Count events in this month
                Object.entries(eventsByDay).forEach(([dayKey, dayCount]) => {
                    if (dayKey.startsWith(monthKey)) {
                        count += dayCount;
                    }
                });

                data.push({
                    label: monthName,
                    count: count,
                    month: monthKey
                });
            }
        }

        // Calculate max for percentage
        const maxCount = Math.max(...data.map(d => d.count), 1);
        data.forEach(d => {
            d.percent = (d.count / maxCount) * 100;
        });

        return data;
    }

    /**
     * Create trends chart HTML with toggle for weekly/monthly
     * @param {Object} eventsByDay - Object with day keys and event counts
     * @returns {string} HTML string
     */
    createTrendsChart(eventsByDay) {
        const weeklyData = this.generateTrendsData(eventsByDay, 'weekly');
        const monthlyData = this.generateTrendsData(eventsByDay, 'monthly');

        const hasWeeklyData = weeklyData.some(d => d.count > 0);
        const hasMonthlyData = monthlyData.some(d => d.count > 0);

        if (!hasWeeklyData && !hasMonthlyData) {
            return '<p class="stats-empty">No trend data available</p>';
        }

        const createBars = (data) => data.map(d => `
            <div class="stats-trend-bar" title="${d.label}: ${d.count} events">
                <div class="stats-trend-fill" style="height: ${Math.max(d.percent, d.count > 0 ? 5 : 0)}%"></div>
                <span class="stats-trend-count">${d.count || ''}</span>
            </div>
        `).join('');

        return `
            <div class="stats-trends-toggle">
                <button class="stats-trend-btn active" data-mode="weekly">Weekly</button>
                <button class="stats-trend-btn" data-mode="monthly">Monthly</button>
            </div>
            <div class="stats-trends-container">
                <div class="stats-trends-chart" id="weeklyTrends">
                    ${createBars(weeklyData)}
                </div>
                <div class="stats-trends-chart hidden" id="monthlyTrends">
                    ${createBars(monthlyData)}
                </div>
            </div>
            <div class="stats-trends-labels" id="weeklyLabels">
                <span>${weeklyData[0]?.label || ''}</span>
                <span>${weeklyData[Math.floor(weeklyData.length / 2)]?.label || ''}</span>
                <span>${weeklyData[weeklyData.length - 1]?.label || ''}</span>
            </div>
            <div class="stats-trends-labels hidden" id="monthlyLabels">
                <span>${monthlyData[0]?.label || ''}</span>
                <span>${monthlyData[Math.floor(monthlyData.length / 2)]?.label || ''}</span>
                <span>${monthlyData[monthlyData.length - 1]?.label || ''}</span>
            </div>
        `;
    }

    /**
     * Export statistics as JSON or CSV
     * @param {string} format - 'json' or 'csv'
     */
    exportStats(format = 'json') {
        const stats = this.calculateStats();
        if (!stats) {
            alert('No statistics to export');
            return;
        }

        const storage = this.calculateStorageEstimate(stats.totalClips);

        // Build export data
        const exportData = {
            generatedAt: new Date().toISOString(),
            summary: {
                totalEvents: stats.totalEvents,
                totalClips: stats.totalClips,
                recordingTime: this.formatDuration(stats.totalRecordingTime),
                estimatedStorage: storage.displayValue,
                dateRange: stats.earliestEvent && stats.latestEvent ?
                    `${new Date(stats.earliestEvent).toLocaleDateString()} - ${new Date(stats.latestEvent).toLocaleDateString()}` :
                    'N/A'
            },
            eventsByType: {
                saved: stats.eventsByType.saved,
                sentry: stats.eventsByType.sentry,
                recent: stats.eventsByType.recent
            },
            triggerReasons: stats.triggerReasons,
            topLocations: Object.fromEntries(stats.topLocations),
            sentryLocations: Object.fromEntries(stats.sentryLocations),
            sentryByHour: stats.sentryByHour.map((count, hour) => ({
                hour: hour,
                label: hour === 0 ? '12am' : hour === 12 ? '12pm' : hour > 12 ? `${hour - 12}pm` : `${hour}am`,
                count: count
            })),
            eventsByDay: stats.eventsByDay
        };

        let blob, filename;

        if (format === 'json') {
            blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
            filename = `teslacam-stats-${new Date().toISOString().split('T')[0]}.json`;
        } else {
            // CSV format
            const lines = [
                '# TeslaCam Statistics Export',
                `# Generated: ${exportData.generatedAt}`,
                '',
                '## Summary',
                `Total Events,${stats.totalEvents}`,
                `Total Clips,${stats.totalClips}`,
                `Recording Time,${this.formatDuration(stats.totalRecordingTime)}`,
                `Estimated Storage,${storage.displayValue}`,
                '',
                '## Events by Type',
                `Saved,${stats.eventsByType.saved}`,
                `Sentry,${stats.eventsByType.sentry}`,
                `Recent,${stats.eventsByType.recent}`,
                '',
                '## Trigger Reasons',
                ...Object.entries(stats.triggerReasons).map(([reason, count]) => `${reason},${count}`),
                '',
                '## Top Locations (All Events)',
                ...stats.topLocations.map(([loc, count]) => `${loc},${count}`),
                '',
                '## Top Sentry Locations',
                ...stats.sentryLocations.map(([loc, count]) => `${loc},${count}`),
                '',
                '## Sentry Events by Hour',
                'Hour,Count',
                ...stats.sentryByHour.map((count, hour) => `${hour},${count}`)
            ];
            blob = new Blob([lines.join('\n')], { type: 'text/csv' });
            filename = `teslacam-stats-${new Date().toISOString().split('T')[0]}.csv`;
        }

        // Download
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }

    /**
     * Normalize trigger reason for display
     * @param {string} reason - Raw trigger reason from event.json
     * @returns {string} Normalized reason
     */
    normalizeTriggerReason(reason) {
        if (!reason) return 'Unknown';

        const lowerReason = reason.toLowerCase();

        if (lowerReason.includes('user_interaction') || lowerReason.includes('dashcam_launcher')) {
            return 'Manual Save';
        }
        if (lowerReason.includes('object_detection')) {
            return 'Object Detected';
        }
        if (lowerReason.includes('accel') || lowerReason.includes('bump')) {
            return 'Vehicle Bump';
        }
        if (lowerReason.includes('honk')) {
            return 'Honk';
        }

        return 'Other';
    }

    /**
     * Format duration in seconds to readable string
     * @param {number} seconds - Duration in seconds
     * @returns {string} Formatted string like "2h 30m"
     */
    formatDuration(seconds) {
        if (seconds < 60) return `${Math.round(seconds)}s`;

        const hours = Math.floor(seconds / 3600);
        const minutes = Math.floor((seconds % 3600) / 60);

        if (hours > 0) {
            return `${hours}h ${minutes}m`;
        }
        return `${minutes}m`;
    }

    /**
     * Show statistics modal
     */
    showModal() {
        const stats = this.calculateStats();

        if (!stats) {
            alert('No events loaded. Open a TeslaCam folder first.');
            return;
        }

        // Remove existing modal
        if (this.modal) {
            this.modal.remove();
        }

        // Calculate additional stats
        const storage = this.calculateStorageEstimate(stats.totalClips);
        const timelineData = this.generateTimelineData(stats.eventsByDay);
        const timelineChartHTML = this.createTimelineChart(timelineData);
        const timeOfDayChartHTML = this.createTimeOfDayChart(stats.sentryByHour);
        const trendsChartHTML = this.createTrendsChart(stats.eventsByDay);

        // Build trigger breakdown HTML
        const triggerHTML = Object.entries(stats.triggerReasons)
            .sort((a, b) => b[1] - a[1])
            .map(([reason, count]) => {
                const percent = Math.round((count / stats.totalEvents) * 100);
                return `
                    <div class="stats-bar-row">
                        <span class="stats-bar-label">${reason}</span>
                        <div class="stats-bar-track">
                            <div class="stats-bar-fill" style="width: ${percent}%"></div>
                        </div>
                        <span class="stats-bar-value">${count} (${percent}%)</span>
                    </div>
                `;
            }).join('');

        // Build locations HTML (top 10)
        const locationsHTML = stats.topLocations
            .map(([location, count], index) => `
                <div class="stats-location-row">
                    <span class="stats-location-rank">${index + 1}.</span>
                    <span class="stats-location-name">${location}</span>
                    <span class="stats-location-count">${count} events</span>
                </div>
            `).join('') || '<p class="stats-empty">No location data available</p>';

        // Build sentry locations HTML
        const sentryLocationsHTML = stats.sentryLocations.length > 0 ?
            stats.sentryLocations.map(([location, count], index) => `
                <div class="stats-location-row">
                    <span class="stats-location-rank">${index + 1}.</span>
                    <span class="stats-location-name">${location}</span>
                    <span class="stats-location-count">${count} events</span>
                </div>
            `).join('') : '<p class="stats-empty">No sentry location data</p>';

        // Build event types HTML with icons
        const typeIcons = {
            saved: '<svg width="12" height="12" viewBox="0 0 24 24" fill="#4caf50"><path d="M17 3H5c-1.11 0-2 .9-2 2v14c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2V7l-4-4zm-5 16c-1.66 0-3-1.34-3-3s1.34-3 3-3 3 1.34 3 3-1.34 3-3 3zm3-10H5V5h10v4z"/></svg>',
            sentry: '<svg width="12" height="12" viewBox="0 0 24 24" fill="#f44336"><path d="M12 1L3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4zm0 10.99h7c-.53 4.12-3.28 7.79-7 8.94V12H5V6.3l7-3.11v8.8z"/></svg>',
            recent: '<svg width="12" height="12" viewBox="0 0 24 24" fill="#9e9e9e"><path d="M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zM12 20c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8zm.5-13H11v6l5.25 3.15.75-1.23-4.5-2.67z"/></svg>'
        };
        const typeColors = { saved: '#4caf50', sentry: '#f44336', recent: '#9e9e9e' };
        const typesHTML = Object.entries(stats.eventsByType)
            .filter(([_, count]) => count > 0)
            .map(([type, count]) => {
                const percent = Math.round((count / stats.totalEvents) * 100);
                return `
                    <div class="stats-type-item">
                        <div class="stats-type-bar" style="width: ${percent}%; background: ${typeColors[type]}"></div>
                        <span class="stats-type-label">
                            ${typeIcons[type] || ''}
                            ${type.charAt(0).toUpperCase() + type.slice(1)}: ${count}
                        </span>
                    </div>
                `;
            }).join('');

        this.modal = document.createElement('div');
        this.modal.className = 'stats-modal';
        this.modal.innerHTML = `
            <div class="stats-overlay"></div>
            <div class="stats-panel">
                <div class="stats-header">
                    <h2>
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" style="margin-right: 8px; vertical-align: middle;">
                            <path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zM9 17H7v-7h2v7zm4 0h-2V7h2v10zm4 0h-2v-4h2v4z"/>
                        </svg>
                        Statistics
                    </h2>
                    <button class="stats-close-btn" title="Close">
                        <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
                            <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>
                        </svg>
                    </button>
                </div>
                <div class="stats-content">
                    <!-- Overview Cards -->
                    <div class="stats-section">
                        <h3>Recording Overview</h3>
                        <div class="stats-grid stats-grid-4">
                            <div class="stats-card">
                                <span class="stats-card-value">${stats.totalEvents}</span>
                                <span class="stats-card-label">Total Events</span>
                            </div>
                            <div class="stats-card">
                                <span class="stats-card-value">${stats.totalClips}</span>
                                <span class="stats-card-label">Total Clips</span>
                            </div>
                            <div class="stats-card">
                                <span class="stats-card-value">${this.formatDuration(stats.totalRecordingTime)}</span>
                                <span class="stats-card-label">Recording Time</span>
                            </div>
                            <div class="stats-card">
                                <span class="stats-card-value">${storage.displayValue}</span>
                                <span class="stats-card-label">Est. Storage</span>
                            </div>
                        </div>
                    </div>

                    <!-- Timeline Chart -->
                    <div class="stats-section">
                        <h3>Events - Last 14 Days</h3>
                        ${timelineChartHTML}
                    </div>

                    <!-- Event Types -->
                    <div class="stats-section">
                        <h3>Event Types</h3>
                        <div class="stats-types">
                            ${typesHTML}
                        </div>
                    </div>

                    <!-- Trigger Breakdown -->
                    <div class="stats-section">
                        <h3>Trigger Reasons</h3>
                        <div class="stats-bars">
                            ${triggerHTML || '<p class="stats-empty">No trigger data available</p>'}
                        </div>
                    </div>

                    <!-- Top Locations -->
                    <div class="stats-section">
                        <h3>Top 10 Locations (All Events)</h3>
                        <div class="stats-locations">
                            ${locationsHTML}
                        </div>
                    </div>

                    <!-- Sentry Time of Day -->
                    ${stats.eventsByType.sentry > 0 ? `
                    <div class="stats-section">
                        <h3>Sentry Events by Time of Day</h3>
                        ${timeOfDayChartHTML}
                    </div>
                    ` : ''}

                    <!-- Sentry Locations -->
                    ${stats.sentryLocations.length > 0 ? `
                    <div class="stats-section">
                        <h3>Top Sentry Locations</h3>
                        <div class="stats-locations">
                            ${sentryLocationsHTML}
                        </div>
                    </div>
                    ` : ''}

                    <!-- Date Range -->
                    ${stats.earliestEvent ? `
                    <div class="stats-section">
                        <h3>Date Range</h3>
                        <p class="stats-date-range">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" style="vertical-align: middle; margin-right: 4px;">
                                <path d="M19 3h-1V1h-2v2H8V1H6v2H5c-1.11 0-1.99.9-1.99 2L3 19c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 16H5V8h14v11zM9 10H7v2h2v-2zm4 0h-2v2h2v-2zm4 0h-2v2h2v-2zm-8 4H7v2h2v-2zm4 0h-2v2h2v-2zm4 0h-2v2h2v-2z"/>
                            </svg>
                            ${new Date(stats.earliestEvent).toLocaleDateString()} - ${new Date(stats.latestEvent).toLocaleDateString()}
                        </p>
                    </div>
                    ` : ''}

                    <!-- Trends Chart -->
                    <div class="stats-section">
                        <h3>Event Trends</h3>
                        ${trendsChartHTML}
                    </div>

                    <!-- Export Buttons -->
                    <div class="stats-section stats-export-section">
                        <h3>Export Statistics</h3>
                        <div class="stats-export-buttons">
                            <button class="stats-export-btn" data-format="json">
                                <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                                    <path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/>
                                </svg>
                                Export JSON
                            </button>
                            <button class="stats-export-btn" data-format="csv">
                                <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                                    <path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/>
                                </svg>
                                Export CSV
                            </button>
                        </div>
                    </div>
                </div>
            </div>
        `;

        document.body.appendChild(this.modal);

        // Event listeners
        const closeBtn = this.modal.querySelector('.stats-close-btn');
        const overlay = this.modal.querySelector('.stats-overlay');

        const closeModal = () => {
            this.modal.remove();
            this.modal = null;
        };

        closeBtn.addEventListener('click', closeModal);
        overlay.addEventListener('click', closeModal);

        // Export buttons
        this.modal.querySelectorAll('.stats-export-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const format = btn.dataset.format;
                this.exportStats(format);
            });
        });

        // Trends toggle buttons
        this.modal.querySelectorAll('.stats-trend-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const mode = btn.dataset.mode;

                // Update active button
                this.modal.querySelectorAll('.stats-trend-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');

                // Show/hide charts
                const weeklyChart = this.modal.querySelector('#weeklyTrends');
                const monthlyChart = this.modal.querySelector('#monthlyTrends');
                const weeklyLabels = this.modal.querySelector('#weeklyLabels');
                const monthlyLabels = this.modal.querySelector('#monthlyLabels');

                if (mode === 'weekly') {
                    weeklyChart?.classList.remove('hidden');
                    monthlyChart?.classList.add('hidden');
                    weeklyLabels?.classList.remove('hidden');
                    monthlyLabels?.classList.add('hidden');
                } else {
                    weeklyChart?.classList.add('hidden');
                    monthlyChart?.classList.remove('hidden');
                    weeklyLabels?.classList.add('hidden');
                    monthlyLabels?.classList.remove('hidden');
                }
            });
        });

        // ESC to close
        const escHandler = (e) => {
            if (e.key === 'Escape' && this.modal) {
                closeModal();
                document.removeEventListener('keydown', escHandler);
            }
        };
        document.addEventListener('keydown', escHandler);
    }
}

// Export for use
window.StatisticsManager = StatisticsManager;
