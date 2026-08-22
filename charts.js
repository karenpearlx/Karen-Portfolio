(function () {
  if (typeof Chart === 'undefined') return;

  var TEAL = '#0f9d7a';
  var TEAL_2 = '#4fd1a8';
  var MUTED = '#9aa0a6';
  var GRID_LIGHT = 'rgba(21,23,26,.07)';
  var GRID_DARK = 'rgba(255,255,255,.08)';
  var TEXT_DARK = 'rgba(255,255,255,.72)';
  var reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var anim = reduce ? false : { duration: 1200, easing: 'easeOutQuart' };

  Chart.defaults.font.family = "'Geist', system-ui, sans-serif";
  Chart.defaults.font.size = 12;
  Chart.defaults.color = '#6b7177';

  var ttr = document.getElementById('ttrChart');
  if (ttr) new Chart(ttr, {
    type: 'bar',
    data: {
      labels: ['0 days', '1 day', '2 days', '3 days', '4–7 days', '8–14 days'],
      datasets: [{ label: 'Winning posts', data: [18, 52, 18, 9, 7, 15], backgroundColor: TEAL, borderRadius: 6, barPercentage: .72 }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: function (c) { return c.parsed.y + ' posts'; } } } },
      scales: {
        y: { beginAtZero: true, grid: { color: GRID_LIGHT }, border: { display: false }, ticks: { stepSize: 10 } },
        x: { grid: { display: false } }
      },
      animation: anim
    }
  });

  var client = document.getElementById('clientChart');
  if (client) new Chart(client, {
    type: 'bar',
    data: {
      labels: ['Client 1', 'Client 8', 'Client 2', 'Client 6', 'Client 3', 'Client 4', 'Client 9', 'Client 5', 'Others'],
      datasets: [{
        label: 'Winning posts',
        data: [30, 18, 14, 14, 7, 6, 5, 5, 20],
        backgroundColor: [TEAL, TEAL, TEAL, TEAL, TEAL_2, TEAL_2, TEAL_2, TEAL_2, '#5d6663'],
        borderRadius: 6, barPercentage: .72
      }]
    },
    options: {
      indexAxis: 'y',
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: function (c) { return c.parsed.x + ' wins'; } } } },
      scales: {
        x: { beginAtZero: true, grid: { color: GRID_DARK }, border: { display: false }, ticks: { color: TEXT_DARK } },
        y: { grid: { display: false }, border: { display: false }, ticks: { color: 'rgba(255,255,255,.85)' } }
      },
      animation: anim
    }
  });

  var winrate = document.getElementById('winrateChart');
  if (winrate) new Chart(winrate, {
    type: 'doughnut',
    data: {
      labels: ['Winning posts (61%)', 'Non-winning (39%)'],
      datasets: [{ data: [153, 97], backgroundColor: [TEAL, '#333a37'], borderWidth: 0, cutout: '70%' }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { position: 'bottom', labels: { padding: 16, boxWidth: 12, boxHeight: 12, color: TEXT_DARK } },
        tooltip: { callbacks: { label: function (c) { return c.parsed + ' of 250 posts'; } } }
      },
      animation: reduce ? false : { animateRotate: true, duration: 1200, easing: 'easeOutQuart' }
    }
  });

  var rank = document.getElementById('rankChart');
  if (rank) new Chart(rank, {
    type: 'doughnut',
    data: {
      labels: ['Top 10 (134)', 'Outside top 10 (678)'],
      datasets: [{ data: [134, 678], backgroundColor: [TEAL, '#dfe3e0'], borderWidth: 0, cutout: '70%' }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { position: 'bottom', labels: { padding: 16, boxWidth: 12, boxHeight: 12 } },
        tooltip: { callbacks: { label: function (c) { return c.parsed + ' of 812 tracked keywords'; } } }
      },
      animation: reduce ? false : { animateRotate: true, duration: 1200, easing: 'easeOutQuart' }
    }
  });

  var cite = document.getElementById('citeChart');
  if (cite) new Chart(cite, {
    type: 'bar',
    data: {
      labels: ['ChatGPT citation events', 'Google AI Overview citations'],
      datasets: [{ data: [1082, 93], backgroundColor: [TEAL, TEAL_2], borderRadius: 6, borderSkipped: false, barThickness: 46 }]
    },
    options: {
      indexAxis: 'y',
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: function (c) { return c.parsed.x.toLocaleString() + ' citations'; } } }
      },
      scales: {
        x: { beginAtZero: true, grid: { color: GRID_LIGHT }, ticks: { color: MUTED } },
        y: { grid: { display: false }, ticks: { color: MUTED } }
      },
      animation: anim
    }
  });

})();
