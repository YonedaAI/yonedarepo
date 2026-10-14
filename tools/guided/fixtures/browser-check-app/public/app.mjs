const total = document.getElementById('total');
document.getElementById('increment').addEventListener('click', () => {
  total.value = String(Number(total.value) + 1);
});
